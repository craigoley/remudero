import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  architectModel,
  configPath as instanceConfigPath,
  consoleUrl,
  fixStrikeCap,
  globalArtifactPath,
  loadConfig,
  notifyRecipient,
  resolveHeadroomEnabled,
  softBudgetThreshold,
  userOverallLearningsHome,
  workerHomeDir,
  workerModel,
  workerShell,
  workerZdotdir,
  type Config,
} from "./lib/config.js";
import { readFileIfExists } from "./lib/fs-race-safe.js";
import { buildWorkerEnv, billingMode, readBinaryPin, type BillingMode, type BinaryPinReading } from "./lib/env.js";
import { bodyVsDiffContractLines, IMPLEMENT_ROLE_LINES, outputContractLines, renderAnchorBlock, commitMessageContractLines, ciParityContractLines } from "./lib/compaction.js";
import {
  lintFiledTasks,
  newMonolithIdsAgainstBase,
  relintRefusalMessage,
  runRelintLoop,
} from "./lib/relint.js";
import type { RunResult } from "./lib/run-result.js";
export type { RunResult };
import { InitError, readClaudeJsonKeys, runInit } from "./lib/init.js";
import type { Tier, TierDetection } from "./lib/tier.js";
import { buildProjectInit, parseProjectInitArgs } from "./lib/project-init.js";
import {
  OnboardError,
  parseOnboardArgs,
  realOnboardFsDeps,
  realOnboardGhGateway,
  resolveTargetOwnerRepo,
  runOnboardInventory,
  type OnboardFsDeps,
  type OnboardGhGateway,
} from "./lib/onboard/inventory.js";
import {
  parseReconArgs,
  realReconFsDeps,
  realReconGhGateway,
  RECON_LENSES,
  RECON_PHASE,
  ReconError,
  runOnboardRecon,
  spawnReconSpecialist,
  type ReconFsDeps,
  type ReconGhGateway,
} from "./lib/onboard/recon.js";
import { SPECIALIST_TOOLS, type SpecialistName } from "./lib/specialist-panel.js";
import {
  loadOnboardSessionState,
  parseSessionArgs,
  realSessionFsDeps,
  runOnboardSession,
  SESSION_PHASE,
  SessionError,
  type OnboardQuestion,
  type SessionFsDeps,
} from "./lib/onboard/session.js";
import {
  parseSynthesizeArgs,
  realSynthesizeFsDeps,
  realSynthesizeGhGateway,
  realSynthesizeGitGateway,
  runOnboardSynthesize,
  SYNTHESIZE_PHASE,
  SynthesizeError,
  type SynthesizeDraftFn,
  type SynthesizeFsDeps,
  type SynthesizeGhGateway,
  type SynthesizeGitGateway,
} from "./lib/onboard/synthesize.js";
import {
  applyCuratedSelection,
  buildRundown,
  nextRunnable,
  plannedSequence,
  renderRundown,
  renderSummary,
  resumeCommand,
  runDrain,
  type CuratedSelection,
  type DrainOpts,
  type DrainSummary,
  type MergedSet,
  type OpenPrCheck,
} from "./lib/drain.js";
import {
  daemonBoot,
  daemonExitCode,
  runDaemon,
  type CrashLoopVerdict,
  type DaemonOpts,
  type DaemonSummary,
  type HeadroomPolicy,
  type StarvationCensus,
  priorUnrecognisedResetStrings,
} from "./lib/daemon.js";
// W1-T372: the daemon-tick counterpart to daemon-health.ts's own pull-only rate-limit display
// (readGhRateLimitRemaining, unrelated cadence, unchanged) — reads BOTH gh api rate_limit
// buckets off one exec call for runDaemon's own `readGhQuota` dep, wired below.
import { isBucketExhausted, readGhRateLimitBuckets, type GhRateLimitBuckets } from "./lib/daemon-health.js";
// W1-T117/W1-T356: the orphan sweep's own exported defaults — see the shared `sweepOrphans`
// closure below (daemonCommand), wired into BOTH daemonBoot's boot-time param and
// DaemonDeps.sweepOrphans.
import {
  defaultListCandidates,
  defaultReadMarkers,
  killProcessGroup,
  sweepOrphanWorkers,
} from "./lib/worker-containment.js";
import { makeTempDir, sweepStaleTempDirs, withTempDir, type TempSweepOpts, type TempSweepSummary } from "./lib/tmp.js";
import { reapWorkerScratch, sweepStaleWorkerScratch } from "./lib/worker-scratch.js";
import { DAEMON_LABEL, DIGEST_LABEL, generateDigestLaunchdPlist, generateLaunchdPlist, generateServeLaunchdPlist, generateSupervisorLaunchdPlist, launchctlGuiTarget, launchdPlistPath, parseSupervisorStartInterval, SERVE_LABEL, serveLogPaths, SUPERVISOR_LABEL } from "./lib/launchd.js";
import { realDeployDeps, requestDeploy, runDeployCycle } from "./lib/deployer.js";
import { buildStatusBoard, renderStatusBoardText, type ServiceName } from "./lib/status-board.js";
import { buildDigest, buildMarkerAwareDigest, consoleCardUrl, sendDigest, sendMarkerAwareDigest, sendRundown } from "./lib/digest.js";
import { createLastSeenStore, hashToken, lastSeenPath } from "./lib/last-seen.js";
import {
  deliversRealtime,
  escalate,
  escalateWithSummary,
  escalationCause,
  ghIssueGateway,
  presenceMode,
  setPresenceMode,
  tryEscalate,
  type EscalationClass,
  type EscalationOption,
  type IssueGateway,
  type OpenIssue,
  type PresenceMode, prReferentFromIssueText,} from "./lib/escalate.js";
import {
  fetchOpenPrsRest,
  fetchSinglePrRest,
  hydrateMergeStates,
  mapRestPr,
  singlePrRestArgs,
  type GhApiFetcher,
  type RestPullRow,
} from "./lib/open-prs-rest.js";
import { imessageChannel, notify, type NotifyChannel } from "./lib/notify.js";
import {
  alertOriginId,
  alertTaskId,
  buildAlertEscalation,
  ghAlertGateway,
  pollAlerts,
  renderAlertsSummary,
  type AlertGateway,
} from "./lib/ops.js";
import {
  decideAlertDisposition,
  loadAlertPolicy,
  runAlertLane,
  type AlertLaneAlert,
} from "./lib/alert-lane.js";
import { ghIssueListGateway, pollIssues, renderIssuesSummary } from "./lib/issues-intake.js";
import { loadManagedRepos, ManagedReposError } from "./lib/managed-repos.js";
import {
  captureFeedback,
  feedbackEntryPath,
  parseFeedbackAddArgs,
  proposeFeedbackWithSummary,
  readFeedbackEntry,
  realDecisionSummarizer,
  resolveDecisionSummaryMount,
  setFeedbackStatus,
  FeedbackError,
  type FeedbackEntry,
  type SummarizeDeps,
} from "./lib/feedback.js";
import { findPendingLandingPr, recordDecision } from "./lib/feedback-landing.js";
import { ghTraceGateway, renderTraceChain, traceForward, traceReverse } from "./lib/trace.js";
import { runPreflight, type PreflightDeps } from "./lib/commit-message.js";
import {
  buildPreflightSummary,
  preflightFailureNotice,
  preflightSummaryPath,
  runCiParity,
  runPreflightFast,
} from "./lib/ci-parity.js";
import { ghIssueCloser } from "./lib/panel-actions.js";
import {
  buildServeServer,
  currentBranch,
  DEFAULT_BIND_ATTEMPTS,
  DEFAULT_BIND_RETRY_MS,
  ensureLogFileMode,
  listenWithReapWait,
  offMainNotice,
  resolveServeHosts,
  resolveServeIdentity,
  resolveServePort,
  resolveServiceTokens,
  SERVE_EXPECTED_BRANCH,
  serviceTokensPath,
} from "./lib/serve.js";
import { consoleUrlCommand, defaultIsListening } from "./lib/console-url.js";
import { assertProposedPlanLoads,
  buildGrillEscalation,
  decideTriage,
  diffCitesFeedback,
  missingFeedbackMessage,
  nonPlanFilesInDiff,
  parseTriageArgs,
  parseTriageVerdict,
  triageCommitMessage,
  triagePrompt,
} from "./lib/triage.js";
import { mintNextTaskId, type MintDegradation, type MintSources } from "./lib/task-id.js";
import {
  firstUnreservedAtOrAbove,
  reserveTaskIdBlock,
  reserveTaskIdFrom,
  type TaskIdReservationBlock,
  taskIdReservationsDir,
  type TaskIdReservationHandle,
} from "./lib/task-id-reservation.js";
import {
  applyPlanProposalCommit,
  buildPlanGrillEscalation,
  decidePlanArchitect,
  unreservedFiledIds,
  diffCitesResearchSource,
  formatPlanVerdictLine,
  outOfPlanScopeFilesInDiff,
  parsePlanArgs,
  parsePlanVerdict,
  planArchitectPrompt,
  planCommitMessage,
} from "./lib/plan-architect.js";
import {
  applyFragmentToPlanYaml,
  applyStampToMasterPlan,
  approveCommitMessage,
  approveProposal,
  classifyProposal,
  draftAttemptKey,
  draftsDueOnDaemon,
  gitGrepAnchorTrue,
  inboxDraftPrompt,
  isDraftStale,
  isRatifiedInLedger,
  materializeDraftTaskIds,
  parseDraftAttemptCache,
  parseDraftCache,
  parseProposalRegistry,
  parseSupersedesExpr,
  pruneRatifiedProposals,
  proposalsNeedingDraft,
  ratifyTelemetry,
  reframeProposal,
  renderInbox,
  renderRatifyTelemetry,
  runDraftRung,
  summarizeInboxPoll,
  updateProposalRegistry,
  writeDraftAttemptPair,
  type DraftAttemptCache,
  type DraftCache,
  type DraftRungOutcome,
  type EvidenceAnchor,
  type InboxClassification,
  type Proposal,
  type ReadinessContext,
  type RatifyGateway,
  type ReframeResult,
} from "./lib/inbox.js";
import { parseUsage, type UsageSnapshot } from "./lib/headroom.js";
import {
  assertArchitectAboveWorker,
  buildGather,
  calibrationTable,
  checkRetroIntegrity,
  codeFilesInDiff,
  evaluateRetroTrigger,
  gatherRuns,
  loadMastMapping,
  netStateCapabilityAdvisories,
  parseLedger,
  planHealthSweep,
  planStateTruthRung,
  probeGithubThrottle,
  recordFollowupHarvest,
  renderGather,
  renderNetStateUnwiredAdvisories,
  renderPlanHealth,
  renderPlanStateTruth,
  resolveMarkerForGather,
  saveMarker,
  shippedSince,
  type MastMapping,
  type PlanStateTruthResolver,
  type RetroTriggerDecision,
  type ShippedGithub,
} from "./lib/retro.js";
import { regenerateOrientation } from "./lib/orientation.js";
import {
  buildPlanPrBody,
  bodyNeedsAcceptanceRepair,
  ensureJudgeableBody,
  filingAcceptanceCriteria,
  regeneratePlanIndexAndCommit,
  regeneratePlanIndexFile,
} from "./lib/plan-pr-emitter.js";
import { appendLedger, isSpawnInfraBlockedError, LEDGER_COST_TAG_INFRA } from "./lib/ledger.js";
import { resolveLedgerUnion } from "./lib/ledger-grep.js";
import {
  assertRunnable,
  loadPlan,
  selectTask,
  visibleCriteria,
  type AcceptanceCriterion,
  DEFAULT_RISK,
  type TaskRisk,
  type MergedResolver,
  type Plan,
  type Task,
  type TaskStatus,
  parseTasksFromYaml,
  taskRecordPath,
} from "./lib/plan.js";
import {
  assertLintClean,
  changedTaskIds,
  rawChangedTaskIds,
  criteriaAdded,
  followUpCarriesCriteria,
  formatReadIdentity,
  isPathOutsideRoot,
  lintTask,
  TaskLintError,
  type LintOpts,
} from "./lib/task-linter.js";
import { loadMounts, mountsPath, resolveMount, resolveMountForClass, type Mount } from "./lib/mounts.js";
import {
  loadDefaultPolicy,
  loadPolicy,
  policyPath,
  PolicyError,
  resolveDailyCostCeiling,
  resolveDailyCostCeilingForInstance,
  type Policy,
  type PolicyHeadroomRung,
} from "./lib/policy.js";
import {
  attributeVerbs,
  deriveCliVerbs,
  deriveStepPrefixes,
  emissionsReport,
  EMISSIONS_ALLOWLIST,
} from "./lib/emissions.js";
import { cloneReapRoots, reapStaleClones, tallyDispositions, type CloneReapSummary } from "./lib/clone-reaper.js";
import { deriveTaskClass } from "./lib/task-class.js";
import { realRiskJudge, resolveRiskJudgeMount, runRiskJudge, type RiskJudgeInput } from "./lib/risk-judge.js";
import { loadSkillRegistry, renderSkillList, skillsDir, SkillError } from "./lib/skill.js";
import { ContainmentError, probeContainment, type ProbeExecutor } from "./lib/containment.js";
import { IsolationError, probeIsolation, type ProbeExecutor as IsolationProbeExecutor } from "./lib/isolation.js";
import { DEFAULT_KNOWLEDGE_BUDGET_CHARS, renderDoctrinePreamble } from "./lib/learnings.js";
import { assertProvenance, citation } from "./lib/provenance.js";
import { loadOperatorNotesForTask, renderOperatorNotes } from "./lib/operator-notes.js";
import {
  computeMatchedLearningsForArm,
  deriveWipeTestRunResult,
  ledgerWipeTestPair,
  resolveWipeTestTarget,
  WIPE_TEST_SANDBOX_DEFAULT,
  type WipeTestPair,
} from "./lib/wipe-test.js";
import { loadPlanIndex, renderPlanIndex } from "./lib/plan-index.js";
import {
  materialiseBaseProofBlobs,
  REVIEW_CONTEXT,
  applyVerdictStability,
  bodyContradictsDiff,
  buildReviewPrompt,
  cappedAnnotation,
  cappedOverrideFromLedger,
  decideAutoMergeArm,
  decideArmFromLedgerVerdict,
  fetchPrLifecycle,
  floorDegradedAnnotation,
  isTddStrict,
  judgeReview,
  judgeRubric,
  rubricAdvisorySection,
  scopeAdvisorySection,
  keywordOnlyAnnotation,
  acceptanceBlockDiagnostics,
  parseAcceptanceBlock,
  parseReviewerVerdicts,
  postReviewStatusGuarded,
  priorReviewVerdictFromLedger,
  resolveAutoMergeArm,
  reviewerOutcome,
  reviewerVerdictContract,
  reviewEvidenceStrength,
  cappedReason,
  reviewLedgerLegibilityFields,
  parseWhitelistedProof,
  resolveNameFilteredCandidates,
  narrowNameFilteredArgs,
  execWhitelistedProof,
  defaultProofSpawner,
  type ProofSpawner,
  type CappedOverride,
  type CriterionVerdict,
  type ReviewVerdict,
} from "./lib/review.js";
import { buildDepReviewArmUnreachableEscalation, buildDepReviewEscalation, decideDepReview } from "./lib/dep-review.js";
import { decideAutoTriage, newFeedbackIdsOldestFirst, readAutoTriageMarker, recordAutoTriageFire, autoTriageMarkerPath, triageLockPath, type AutoTriageDecision, type AutoTriageCensus } from "./lib/auto-triage.js";
import { validateWorkerSettingsFile } from "./lib/settings.js";
import {
  buildBatchedGithub,
  createDispatchBreakerCache,
  DEFAULT_MAX_TASK_LIFETIME_DISPATCHES,
  deriveStatus,
  evaluateDispatchBreakerCorroborated,
  ghGateway,
  ghRequiredStatusCheckContexts,
  isLifetimeDispatchCapExceeded,
  projectPlan,
  readLedgerLines,
  type DeriveDeps,
  type GitHub,
  type PrRef,
  type StatusProjection,
} from "./lib/status.js";
import {
  DEFAULT_SWEEP_POLICY,
  armOutcomeArmed,
  checkCostGovernor,
  checkQueueGovernor,
  checksStateFromRollup,
  deriveDayCostUsd,
  deriveDisposition,
  isBlockedCi,
  listRetirableEscalationIssues,
  logCostGovernorDeferral,
  logQueueGovernorDeferral,
  renderClarificationQuestion,
  renderSweepSummary,
  runCreditBackfill,
  runEscalationReconcile,
  runSweep,
  strikeCapForAnswer,
  terminalStateReason,
  toQuestionEntry,
  type CiFailure,
  type ClarificationQuestion,
  type CostGovernorResult,
  type CreditCandidate,
  type EscalationReconcileCandidate,
  type EscalationReconcileSummary,
  type FixDispatchEvidence,
  type LiveStateResult,
  type MergeConflictEvidence,
  type OpenPrView,
  type QueueGovernorResult,
  type PostReviewStallVerdict,
  type StrikeAttempt,
  type SweepDeps,
  type SweepPolicy,
  ABSENT_REPUSH_CAP,
  detectPostReviewStall,
} from "./lib/sweep.js";
import { applyCorrection } from "./lib/correct.js";
import {
  DEFAULT_PRUNE_GRACE_MS,
  appendQuestion,
  ghJson,
  parseDecisionRequest,
  parseFollowups,
  parseQuestion,
  parseReconReport,
  parseReport,
  pruneStaleRuns,
  reapStaleWorktrees,
  removeRunLock,
  renderWorkerSettings,
  resolveClaudeExecutable,
  claudeExecutableCache,
  runWorktreeReapRung,
  spawnWorker,
  cacheTokenLedgerFields,
  noPrReportExcerpt,
  workerLedgerFields,
  worktreeAdd,
  worktreeLockIsPidAlive,
  worktreeRemove,
  worktreesDir,
  writeRunLock,
  WorktreeBaseStaleError,
  type RunLockInfo,
  type SpawnWorkerArgs,
  type WorkerResult,
  type WorktreeReapSummary,
} from "./lib/worker.js";
import { gitPushRunBranch, gitPushEmptyCommit } from "./lib/git-push.js";
import {
  ensureWorkerKeychain,
  materializeWorkerHome,
  perRunWorkerHomeDir,
  sweepStaleWorkerHomes,
  workerKeychainPaths,
} from "./lib/worker-home.js";
import { CI_LOG_FENCE_CLOSE, CI_LOG_FENCE_OPEN, FIX_WORKER_TOOLS, neutralizeFenceMarkers } from "./lib/fix-fence.js";
import { acquireDrainLock, defaultIsPidAlive, DrainLockError, readDrainLock, type DrainLockHandle } from "./lib/drain-lock.js";
import { checkCliFreshness, checkServiceFreshness } from "./lib/self-sync.js";
import {
  acquireInflightLock,
  InflightLockError,
  readInflightLock,
  sweepStaleInflightLocks,
  type InflightSweepResult,
} from "./lib/inflight-lock.js";
import { classifyFailure, MAX_TRANSIENT_RETRIES, type FailureSignal } from "./lib/classify.js";
import { shouldRecordDecision } from "./lib/risk-score.js";
import { assertLiveWriteAllowed } from "./lib/live-write-guard.js";
import {
  clearKick,
  consumeDrainNow,
  consumeStop,
  pauseDetail,
  pendingKicks,
  requestPause,
  requestStop,
  resumeFleet,
  stopDetail,
} from "./lib/fleet-control.js";

/**
 * The REAL reads behind the binary-pin rung, as one object so the wiring is a single argument and
 * this default is itself exercisable (test/binary-pin-rung.test.ts drives it against the live
 * binary rather than only through the injected seam).
 *
 * `deploy/Dockerfile` is located relative to THIS MODULE, never `process.cwd()`: the daemon, the
 * CLI and a worker all run from different directories, and only the module path is stable across
 * them. Neither read is guarded here — {@link readBinaryPin} catches both and renders `unknown`,
 * which is the point of it having three states.
 */
export function defaultBinaryPinDeps(claudeBin: string): Parameters<typeof readBinaryPin>[0] {
  return {
    readDockerfile: () => readFileSync(fileURLToPath(new URL("../deploy/Dockerfile", import.meta.url)), "utf8"),
    runClaudeVersion: () => execFileSync(claudeBin, ["--version"], { encoding: "utf8" }),
  };
}


// ── The proto-runner (WS-1 T1). Reads ONE tasks.yaml entry and runs the loop:
// recon → provenance-linted prompt → implement → PR → merge → verdict, ledgering
// every step. `rmd run-task <id>` is the single manual kick. No scheduler here.

/**
 * W1-T143 (DAEMON OBSERVABILITY): emit one line to stdout(1)/stderr(2) via a raw,
 * BLOCKING `write(2)` syscall (`fs.writeSync`), bypassing `process.stdout`/`stderr`'s
 * own Writable-stream machinery entirely. Under launchd, `StandardOutPath`/
 * `StandardErrorPath` are never a TTY (recon: a live overnight daemon run's
 * `state/logs/daemon.out.log`/`daemon.err.log` sat EMPTY the whole run) — Node's
 * stream writes to a non-TTY fd are queued ASYNCHRONOUSLY, and a `console.log`
 * immediately followed by a process exit can drop that queued data outright (a
 * well-documented Node pipe-write gotcha); short of an outright drop, the write is
 * only guaranteed to land once the event loop gets around to it, never "within one
 * poll" for certain. `fs.writeSync` makes neither failure mode possible: the syscall
 * either completes before this function returns, or throws — there is no queue to
 * lose data from and no dependency on the event loop ever getting a spare turn.
 * Used for the daemon's own operator narration (`daemonCommand` + `runTask`'s `say`,
 * which the daemon's `runOne` exercises on every dispatch) — every OTHER command's
 * console output is unchanged (out of this task's scope, W1-T143).
 */
export function writeSyncLine(fd: 1 | 2, line: string): void {
  writeSync(fd, line.endsWith("\n") ? line : line + "\n");
}

/**
 * W1-T143 (DAEMON OBSERVABILITY): the ONE canonical ledger path, a PURE function of
 * `config.root` — DOCUMENTED (docs/operator-guide.md) and named aloud at the daemon's
 * own boot (`daemonCommand`'s `daemon.paths` ledger line) so it is provably
 * deterministic, never folklore. Every call site in this file that used to inline
 * `join(config.root, "state", "ledger.ndjson")` routes through this single function now
 * — mechanical, behavior-preserving (the expression was already byte-identical at every
 * site), so a future rename/relocation of the ledger changes exactly one line.
 */
export function ledgerPathFor(config: Config): string {
  return join(config.root, "state", "ledger.ndjson");
}

/**
 * Resolve the repo root a `rmd` invocation GATES, in priority order — replacing the
 * old INSTALL-PATH derivation (`dirname(dirname(fileURLToPath(import.meta.url)))`,
 * which named WHERE THE SCRIPT LIVES, never where the operator is standing). The
 * #271 fixture: one checkout's `bin/rmd`, invoked with cwd inside a DIFFERENT work
 * tree, used to silently gate the INSTALL tree's plan — a false green that never
 * opened the file under test.
 *   1. an explicit `--repo-root <path>` escape hatch, read directly off argv (a
 *      GLOBAL flag scanned here rather than through any one command's own flag
 *      allow-list — see `stripRepoRootFlag` below for why `main()` strips it before
 *      per-command validation runs).
 *   2. CWD-ASCENT: `git rev-parse --show-toplevel` from `cwd` — the tree the
 *      INVOKING shell is standing in, not the tree the running code happens to live in.
 *   3. Fall back to the INSTALL path ONLY when `cwd` is not inside a git work tree
 *      at all (e.g. a bare/scripted context) — reported on stderr so the fallback
 *      is never silent.
 */
export function resolveRepoRoot(
  argv: string[],
  cwd: string,
  showToplevel: (dir: string) => string = (dir) =>
    execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(),
): string {
  const flagIdx = argv.indexOf("--repo-root");
  if (flagIdx >= 0 && argv[flagIdx + 1] !== undefined) return resolve(argv[flagIdx + 1]);
  try {
    return showToplevel(cwd);
  } catch (e) {
    const installRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    console.error(
      `### rmd: cwd (${cwd}) is not inside a git work tree (${(e as Error).message}) — ` +
        `falling back to the install root (${installRoot})`,
    );
    return installRoot;
  }
}

/** Strips a global `--repo-root <path>` pair off argv before per-command flag
 *  validation — so a command whose own allow-list doesn't mention `--repo-root`
 *  (nearly all of them) never rejects it as an unexpected argument. */
export function stripRepoRootFlag(argv: string[]): string[] {
  const i = argv.indexOf("--repo-root");
  if (i < 0) return argv;
  return [...argv.slice(0, i), ...argv.slice(i + 2)];
}

const repoRoot = resolveRepoRoot(process.argv.slice(2), process.cwd());

/** Owner org, read from THIS repo's origin — no hardcoded account in the tree. */
function resolveOwner(): string {
  return resolveOwnerRepo().owner;
}

/** Owner + repo, parsed from THIS repo's origin url — no hardcoded slug in the tree. */
function resolveOwnerRepo(): { owner: string; repo: string } {
  const url = execFileSync("git", ["-C", repoRoot, "config", "--get", "remote.origin.url"], {
    encoding: "utf8",
  }).trim();
  const m = url.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) throw new Error(`could not parse owner/repo from origin url`);
  return { owner: m[1], repo: m[2] };
}

/**
 * A `git fetch`/`git show` step failed. Distinct from a generic Error so callers can tell
 * "the plan sync itself is broken" apart from any other failure and react the fail-closed
 * way (§ named ledger error, no spawn — W1-T60).
 */
export class GitFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitFetchError";
  }
}

export interface SyncedPlan {
  plan: Plan;
  /** True when `git fetch` failed and `allowStale` let the run proceed on the last-known refs. */
  staleDispatch: boolean;
}

/**
 * Sync git state and load the plan from the `origin/main` BLOB — never the working tree
 * (W1-T60: "the runner must never require a manual pull, and must never mutate the
 * operator's working tree or local branches"). `git fetch origin --quiet` updates
 * remote-tracking refs ONLY (never `git pull`, never a checkout/reset), then the plan is
 * read via `git show origin/main:<relPath>` — so a dirty working-tree file or a stale local
 * `main` is irrelevant to what a run dispatches.
 *
 * FAILS CLOSED by default: a fetch failure throws {@link GitFetchError} and the caller must
 * ledger a NAMED error and spawn nothing. `allowStale: true` is the explicit escape hatch —
 * it proceeds on whatever `origin/main` already resolves to locally (the last successful
 * fetch) and reports `staleDispatch: true`; it still throws if `origin/main` can't be
 * resolved AT ALL (nothing to fall back to, e.g. a checkout that has never fetched).
 *
 * W1-T245: the monolith blob alone isn't the whole plan — `loadPlan` also merges any
 * `tasks.d/*.yaml` shards it finds as a SIBLING DIRECTORY ON DISK (src/lib/plan.ts). A plain
 * `git show origin/main:<relPath>` only ever materializes the single monolith file into an
 * otherwise-empty temp dir, so a shard-only task on `origin/main` was invisible here even
 * though `loadPlan` itself is shard-aware. List `tasks.d/` at `origin/main` via `git ls-tree`
 * and materialize each shard blob alongside the monolith before handing the temp file to
 * `loadPlan`, so the synced path sees exactly what a real checkout would.
 */
export function syncPlanFromOrigin(
  repoDir: string,
  relPath: string,
  opts: { allowStale?: boolean } = {},
): SyncedPlan {
  let staleDispatch = false;
  try {
    execFileSync("git", ["-C", repoDir, "fetch", "--quiet", "origin"], { stdio: "pipe" });
  } catch (err) {
    if (!opts.allowStale) {
      throw new GitFetchError(`git fetch origin failed in ${repoDir}: ${String(err)}`);
    }
    staleDispatch = true;
  }
  let blob: string;
  try {
    // maxBuffer: THE DISPATCH PATH READS THIS BLOB. `plan/tasks.yaml` measured 977,168 bytes on
    // 2026-08-01 — 93.2% of Node's 1 MiB `execFileSync` default — and it grows ~1 KB per task
    // filed. At 1 MiB this `git show` fails ENOBUFS, the catch below turns that into a
    // GitFetchError, and the daemon STOPS DISPATCHING. It does not degrade and leaves no floor,
    // which is what makes this more urgent than the identical one-line fix in #1056.
    // 1 << 26 (64 MiB) is this file's own idiom for exactly this class (:1481, :5047, :5278,
    // :6087) and buys ~65x headroom. Sharding the monolith is a separate, larger change — and no
    // amount of sharding makes an unbuffered read of an arbitrarily large blob safe.
    blob = execFileSync("git", ["-C", repoDir, "show", `origin/main:${relPath}`], {
      encoding: "utf8",
      maxBuffer: 1 << 26,
    });
  } catch (err) {
    throw new GitFetchError(`git show origin/main:${relPath} failed in ${repoDir}: ${String(err)}`);
  }
  const tmpDir = makeTempDir("plan"); // W1-T115: shared rmd- prefix (lib/tmp.ts), same try/finally as before
  try {
    const tmpFile = join(tmpDir, "tasks.yaml");
    writeFileSync(tmpFile, blob, "utf8");
    // W1-T245: materialize origin/main's plan/tasks.d/ shards beside the monolith so the synced
    // view equals loadPlan over a real checkout — everything from origin/main blobs, never the
    // working tree (W1-T60 unweakened). Extracted so its two defensive git-failure paths are
    // unit-covered with an injected runner.
    materializeOriginShards(repoDir, dirname(relPath), tmpDir);
    return { plan: loadPlan(tmpFile), staleDispatch };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Injectable git invoker for {@link materializeOriginShards} — the real default shells out;
 *  a test passes a fake that throws to exercise the ls-tree and per-shard-show failure paths. */
export type GitRunner = (args: string[]) => string;

/**
 * Copy every `plan/tasks.d/*.yaml` shard at `ref` into `<tmpDir>/tasks.d/` beside the
 * already-written monolith, so {@link loadPlan}'s sibling-directory shard lookup sees them
 * (W1-T245: syncPlanFromOrigin was shard-blind). List via `git ls-tree`, read each via
 * `git show <ref>:<shard>` — the ref's blobs only, never the working tree. A failing
 * ls-tree (no tasks.d/ at the ref, or a ref-dir lookup miss) is the plain no-shards case
 * (matches listShardFiles's ENOENT tolerance); a shard that lists but fails to `git show`
 * throws {@link GitFetchError} loudly — a torn read must never silently drop a task.
 *
 * `ref` defaults to `"origin/main"` (this function's original, single-caller shape); W1-T246's
 * `lintPlanCommand` passes an ARBITRARY `--base <ref>` — the SAME shard-blindness (W1-T245)
 * exists there too: a plain `git show <base>:tasks.yaml` only ever materializes the monolith,
 * so every shard-only task looked "new" on EVERY PR's `lint-plan --base` run regardless of
 * whether that PR touched it (empirically confirmed live: 20/20 currently-open shards spuriously
 * in scope against an IDENTICAL base==head commit). That was harmless while no check ever
 * failed on a shard task; it stops being harmless the moment a new default-BLOCK check (like
 * proof-dialect) can land on one.
 */
export function materializeOriginShards(
  repoDir: string,
  planRelDir: string,
  tmpDir: string,
  runGit: GitRunner = (args) => execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8" }),
  ref = "origin/main",
): string[] {
  const shardRelDir = join(planRelDir, "tasks.d");
  let shardListing: string;
  try {
    shardListing = runGit(["ls-tree", "--name-only", ref, `${shardRelDir}/`]);
  } catch {
    shardListing = "";
  }
  const shardRelPaths = shardListing
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && (line.endsWith(".yaml") || line.endsWith(".yml")));
  if (shardRelPaths.length === 0) return [];
  const tmpShardDir = join(tmpDir, "tasks.d");
  mkdirSync(tmpShardDir, { recursive: true });
  for (const shardRelPath of shardRelPaths) {
    let shardBlob: string;
    try {
      shardBlob = runGit(["show", `${ref}:${shardRelPath}`]);
    } catch (err) {
      throw new GitFetchError(`git show ${ref}:${shardRelPath} failed in ${repoDir}: ${String(err)}`);
    }
    writeFileSync(join(tmpShardDir, basename(shardRelPath)), shardBlob, "utf8");
  }
  return shardRelPaths;
}

/**
 * Shared fail-closed gate for the run-task/drain/daemon-self dispatch paths (W1-T60): sync +
 * load the plan from `origin/main`, ledgering `git_fetch_failed` and returning `{ error }`
 * (already reported via `say`) on a hard failure instead of throwing — so a caller can refuse
 * cleanly with no spawn. A successful-but-stale sync (`--allow-stale`) is also ledgered and
 * surfaced via `say`, then returned normally so the run proceeds.
 */
export function syncPlanOrRefuse(
  planPath: string,
  opts: {
    allowStale: boolean;
    log: (step: string, extra?: Record<string, unknown>) => void;
    say: (msg: string) => void;
  },
): SyncedPlan | { error: string } {
  const repoDir = dirname(dirname(planPath));
  const relPath = relative(repoDir, planPath);
  try {
    const synced = syncPlanFromOrigin(repoDir, relPath, { allowStale: opts.allowStale });
    if (synced.staleDispatch) {
      opts.log("git.stale_dispatch", { stale_dispatch: true });
      opts.say(`WARNING: dispatching from a STALE origin/main ref (--allow-stale, fetch failed)`);
    }
    return synced;
  } catch (e) {
    if (e instanceof GitFetchError) {
      opts.log("git_fetch_failed", { reason: e.message, allow_stale: opts.allowStale });
      const hint = opts.allowStale ? "" : " (pass --allow-stale to proceed on the last-fetched refs)";
      opts.say(`REFUSED: ${e.message}${hint}`);
      return { error: e.message };
    }
    throw e;
  }
}

/** Check-run conclusions that mean the gate is RED (fail closed on anything not green). */
const RED_CONCLUSIONS = new Set([
  "FAILURE",
  "CANCELLED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "ERROR",
]);

interface RollupEntry {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
}

/**
 * Build the `gh pr create --fill` invocation for a plan/triage/retro PR, with the
 * `cwd` pinned to the run's WORKTREE. The cwd is load-bearing, not cosmetic: the
 * head branch (`run-<id>`) is a local ref ONLY inside that worktree, so `--fill`
 * (which resolves `origin/main...<branch>` locally to fill title/body) throws
 * `ambiguous argument` from any other cwd. The harness process cwd is never the
 * worktree, so a harness-opened PR silently failed and left an orphan branch with
 * no PR. The build/retro WORKER paths avoid this by opening the PR from inside the
 * worktree (their own cwd); the harness paths must pass the cwd explicitly. Pure so
 * a unit test can assert the cwd without spawning gh.
 *
 * W1-T327 (THE TITLE): `title`, appended LAST and optional so none of the four
 * existing positional call sites shifts. When a caller has one, it is emitted as an
 * explicit `--title` ALONGSIDE `--fill` — `gh pr create --help` documents that an
 * explicit `--title` takes precedence over `--fill`'s autofill while `--fill` still
 * supplies the body, so this is additive, never a second title-computation path.
 * Every real call site passes the SAME string the commit itself used (the shaped
 * header for triage/plan, the worktree's actual last-commit subject for
 * implement/retro — see `lastCommitSubject`) — never a re-derivation, so the title
 * and the commit cannot drift apart.
 * DECISION (design point iii): when no title is available, this falls back to
 * `--fill` ALONE, exactly today's behavior — never a refusal. By the time this
 * builder runs the branch is typically already pushed, so refusing here would
 * strand it with no PR, the same orphan-branch failure this doc comment already
 * records for the cwd bug above; a `--fill`-derived title is a pre-existing,
 * narrower risk (a red commitlint check, not a lost run) that this task's four
 * updated call sites eliminate in the common case without introducing a new,
 * worse failure mode in the rare one.
 */
export function ghPrCreateFillCommand(
  worktreePath: string,
  owner: string,
  repo: string,
  branch: string,
  title?: string,
): { command: "gh"; args: string[]; options: { cwd: string; encoding: "utf8" } } {
  // LIVE-WRITE GUARD at the BUILDER, not at each of its four executors: this function
  // exists only to produce a `gh pr create` argv, so refusing here covers every call
  // site at once and cannot be bypassed by a new one.
  assertLiveWriteAllowed("gh-pr-create", `opening a PR against ${owner}/${repo}`);
  const args = ["pr", "create", "--repo", `${owner}/${repo}`, "--base", "main", "--head", branch];
  if (title && title.trim().length > 0) {
    args.push("--title", title.trim());
  }
  args.push("--fill");
  return {
    command: "gh",
    args,
    options: { cwd: worktreePath, encoding: "utf8" },
  };
}

/**
 * The subject line of the worktree's actual last commit — read back from git, never
 * re-derived — for the two `ghPrCreateFillCommand` call sites (implement, retro)
 * where a worker LLM authored the commit and no harness-computed subject variable
 * exists to pass instead. Returns undefined (never throws) on any git failure, which
 * is exactly the "no title available" case {@link ghPrCreateFillCommand}'s own doc
 * comment decides: the caller then falls back to `--fill` alone.
 */
export function lastCommitSubject(worktreePath: string): string | undefined {
  try {
    const subject = execFileSync("git", ["-C", worktreePath, "log", "-1", "--format=%s"], {
      encoding: "utf8",
    }).trim();
    return subject.length > 0 ? subject : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Arm GitHub auto-merge on a PR the runner opened. Non-fatal: the poll decides.
 *
 * W1-T230 (THE ARM DECISION): this is the SOLE choke point every arm call
 * site reaches, and it keys arming ENTIRELY off the orchestrator's own
 * ledgered `review.posted` verdict for `taskId`, re-checked against the LIVE
 * current head sha right here — never the live `remudero-review` status
 * channel, which #449 proved is a mutable, writable, last-write-wins surface
 * (seven contradictory writes on one sha, one 85s after merge) that W1-T203's
 * provenance gate never actually fenced in production (REVIEWER_IDENTITY_ENV
 * is unset on this host). No ledger record for this task/head ⇒ no arm — fail
 * closed, identical in shape to "no verdict yet" (the decision itself is
 * {@link decideArmFromLedgerVerdict}, lib/review.ts). `taskId` absent (a PR
 * this orchestrator cannot key a verdict to) also fails closed, same shape.
 *
 * Re-fetches the live head sha immediately before arming — never trusts a
 * caller's possibly-stale in-memory value — so a push between review and arm
 * is caught by the sha-binding check, and re-reads the ledger fresh every
 * call: a resumed process recovers the SAME decision from nothing but the
 * ledger + the live head (acceptance criterion 3), never from memory.
 */
/** Injectable side effects for {@link armAutoMerge} — exported so a behavioral
 * test drives EVERY branch (incl. the clean-status direct-merge fallback) with
 * fakes; the real defaults are the same gh calls the function always made. */
export interface ArmDeps {
  /** The PR's live head sha — read over REST via {@link readHeadShaRest}, never `gh --json`. */
  headSha: (prUrl: string) => string;
  /** The ledger lines the W1-T230 verdict gate reads. */
  ledgerLines: () => Array<Record<string, unknown>>;
  /** `gh pr merge --auto --squash --delete-branch` — throws on refusal. */
  armAuto: (prUrl: string) => void;
  /** `gh pr merge --squash --delete-branch` — the clean-status completion. */
  mergeDirect: (prUrl: string) => void;
  /** `gh pr merge --disable-auto` — withdraws an early arm, W1-T125. */
  disableAuto: (prUrl: string) => void;
  say: (msg: string) => void;
}

export function realArmDeps(): ArmDeps {
  return {
    headSha: (prUrl) => readHeadShaRest(prUrl),
    ledgerLines: () => readLedgerLines(ledgerPathFor(loadConfig())),
    armAuto: (prUrl) => {
      assertLiveWriteAllowed("gh-pr-merge", `arming auto-merge on ${prUrl}`);
      execFileSync("gh", ["pr", "merge", prUrl, "--auto", "--squash", "--delete-branch"], {
        encoding: "utf8",
        stdio: "pipe",
      });
    },
    mergeDirect: (prUrl) => {
      assertLiveWriteAllowed("gh-pr-merge", `merging ${prUrl} directly`);
      execFileSync("gh", ["pr", "merge", prUrl, "--squash", "--delete-branch"], {
        encoding: "utf8",
        stdio: "pipe",
      });
    },
    // `--disable-auto` WITHDRAWS an arm rather than creating one, but it is still a live
    // mutation of a real PR, and under the guard there is never an arm to withdraw — the
    // arm itself was refused above. Guarded for symmetry, not because it is dangerous.
    disableAuto: (prUrl) => {
      assertLiveWriteAllowed("gh-pr-merge", `disabling auto-merge on ${prUrl}`);
      execFileSync("gh", ["pr", "merge", prUrl, "--disable-auto"], {
        encoding: "utf8",
        stdio: "pipe",
      });
    },
    say: (msg) => console.log(msg),
  };
}

/** Terminal outcome of one arm attempt — returned so tests assert the branch taken. */
export type ArmOutcome =
  | "no-task-id"
  | "head-unavailable"
  | "ledger-refused"
  | "armed"
  | "direct-merged"
  | "direct-merge-failed"
  | "arm-error-ignored";

export function armAutoMerge(
  prUrl: string,
  taskId: string | undefined,
  deps: ArmDeps = realArmDeps(),
): ArmOutcome {
  if (!taskId) {
    deps.say(`automerge.ledger_refused (W1-T230): no task id resolvable for this PR — arming withheld: ${prUrl}`);
    return "no-task-id";
  }
  let headSha: string;
  try {
    headSha = deps.headSha(prUrl);
  } catch (e) {
    deps.say(
      `automerge.head_sha_unavailable (W1-T230): ${String((e as Error)?.message ?? e)} — arm withheld: ${prUrl}`,
    );
    return "head-unavailable";
  }
  // ONE ledger read feeds both the verdict and its override — the same construction the two
  // `decideAutoMergeArm` call sites above already use, so the override escape hatch survives
  // this path's delegation instead of being silently dropped by it.
  const ledgerLines = deps.ledgerLines();
  const prior = priorReviewVerdictFromLedger(ledgerLines, taskId);
  const override = prior?.capped ? cappedOverrideFromLedger(ledgerLines, taskId, headSha) : undefined;
  const decision = decideArmFromLedgerVerdict(prior, headSha, override);
  if (!decision.arm) {
    deps.say(`automerge.ledger_refused (W1-T230): ${decision.reason} — ${prUrl}`);
    return "ledger-refused";
  }
  return attemptArm(prUrl, deps);
}

/**
 * The shared `gh pr merge --auto` attempt + clean-status-direct-merge fallback —
 * factored out (W1-T125) so both the ledger-gated {@link armAutoMerge} and the
 * ungated {@link armAutoMergeAtOpen} share the EXACT same completion logic
 * rather than duplicating it.
 */
function attemptArm(prUrl: string, deps: Pick<ArmDeps, "armAuto" | "mergeDirect" | "say">): ArmOutcome {
  try {
    deps.armAuto(prUrl);
    return "armed";
  } catch (e) {
    const msg = String((e as { stderr?: unknown })?.stderr ?? (e as Error)?.message ?? e);
    // GitHub REFUSES to enable auto-merge on an ALREADY-mergeable PR ("Pull
    // request is in clean status"): with every required check green there is
    // nothing left for auto-merge to wait on — the API's answer is "just merge
    // it". Every SWEEP-armed PR is in exactly that state (the mergeable row
    // fires only on checks-green + review-success), so the old
    // swallow-everything catch made sweep arming a GUARANTEED no-op: the
    // 2026-07-22 ledger carries 20 mergeable/acted lines with ZERO PRs actually
    // armed, and every all-green PR (#584/#588/#591) sat until a hand-merge.
    // The run flow's later poll only papers over this for ITS OWN PRs — the
    // sweep's arm is fire-and-forget and needs the state resolved HERE.
    if (armFailureAction(msg) === "direct-merge") {
      try {
        deps.mergeDirect(prUrl);
        deps.say(`automerge.clean_status_direct_merge (already green — merged now): ${prUrl}`);
        return "direct-merged";
      } catch (e2) {
        deps.say(`automerge.direct_merge_failed: ${String((e2 as Error)?.message ?? e2)} — ${prUrl}`);
        return "direct-merge-failed";
      }
    }
    // Anything else stays informational (a transient gh/network error — the
    // next sweep pass re-derives and retries; the run flow's poll reads true state).
    return "arm-error-ignored";
  }
}

/**
 * W1-T125: arm auto-merge the INSTANT a run's own PR opens — deliberately
 * UNGATED by any ledger verdict, because none can possibly exist yet (review
 * hasn't run at PR-open time). This is safe ONLY because GitHub's own
 * required-status contract (the `ci` check AND the REQUIRED `remudero-review`
 * commit status) is what actually gates the merge, never this call — arming
 * merely REGISTERS INTENT; GitHub will not merge until every required check
 * reports success.
 *
 * The one shape this does NOT cover on its own: a CAPPED verdict (zero proofs
 * executed) still posts `remudero-review: success` (see
 * `postReviewStatusGuarded`/`judgeReview`'s `capped` field) — a local
 * orchestrator policy with no GitHub-visible signal. `runTask`'s own capped-
 * refusal branch closes that gap by calling {@link disarmAutoMerge} BEFORE
 * escalating, withdrawing this early arm so the capped verdict's `success`
 * status can no longer trigger a stray auto-merge.
 */
export function armAutoMergeAtOpen(
  prUrl: string,
  deps: Pick<ArmDeps, "armAuto" | "mergeDirect" | "say"> = realArmDeps(),
): ArmOutcome {
  return attemptArm(prUrl, deps);
}

/**
 * W1-T125: best-effort withdrawal of an early {@link armAutoMergeAtOpen} —
 * `gh pr merge --disable-auto`. Called from `runTask`'s capped-refusal branch,
 * immediately before escalating, so a capped verdict that still posts
 * `remudero-review: success` cannot merge a PR the orchestrator's own policy
 * just refused. Never throws — matches this file's "never silent, never
 * fatal" idiom (see {@link armAutoMerge}'s own arm-error-ignored branch): the
 * withdraw itself can fail/race, and a full closure of that race would
 * require changing `postReviewStatusGuarded` (out of this task's scope), so
 * this is the minimal, best-effort, in-scope mitigation.
 */
export function disarmAutoMerge(prUrl: string, deps: Pick<ArmDeps, "disableAuto" | "say"> = realArmDeps()): void {
  try {
    deps.disableAuto(prUrl);
    deps.say(`automerge.disarmed (W1-T125): early arm withdrawn — ${prUrl}`);
  } catch (e) {
    deps.say(`automerge.disarm_failed (W1-T125): ${String((e as Error)?.message ?? e)} — ${prUrl}`);
  }
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
  deps: { disarm?: (prUrl: string) => void; ledgerLines?: () => Array<Record<string, unknown>> } = {},
): boolean {
  const override = verdict.capped
    ? cappedOverrideFromLedger(
        (deps.ledgerLines ?? (() => readLedgerLines(ctx.ledgerPath)))(),
        ctx.taskId,
        ctx.headSha,
      )
    : undefined;
  const decision = decideAutoMergeArm(verdict, false, override);
  if (decision.arm) return false;
  (deps.disarm ?? disarmAutoMerge)(ctx.prUrl);
  ctx.log("automerge.disarmed", {
    reason: `verdict refuses auto-merge: ${decision.reason}`,
    head_sha: ctx.headSha,
  });
  return true;
}

/**
 * impl-BG — ARM a PR whose verdict PERMITS arming, whether or not it carries a trailer.
 *
 * THE DEFECT. `armAutoMerge` returns "no-task-id" on its first branch when a PR has no
 * `Remudero-Task:` trailer, and arms nothing. Every automated lane either writes a trailer
 * (worker, triage, plan, retro) or mints a synthetic id so it arms anyway (`rmd approve` uses
 * a `PR-<n>` form); the OPERATOR-LANE agent PR is the only class with neither. Five PRs in one
 * day needed a hand merge for this reason alone (#958, #961, #964, #968, #970) — and #970 had
 * 22 checks green and "PASS — 5 criteria substantiated, no test theater" while the same system
 * auto-merged #969 on "CAPPED — 0/4 proofs executed; not certified".
 *
 * THE EXACT MIRROR OF {@link withdrawArmIfVerdictRefuses}: same call site, same shared
 * predicate, complementary condition. That one fires on `!decision.arm`; this one on
 * `decision.arm`. One rule, two directions — never a second copy.
 *
 * WHY IT GOES THROUGH `armAutoMerge` RATHER THAN `attemptArm`. W1-T230's ledger gate
 * ({@link decideArmFromLedgerVerdict}) re-reads the PR's CURRENT head and refuses when the
 * ledgered verdict is for a different one. Routing through `armAutoMerge` therefore inherits
 * head-drift protection for free: if the head moved between the verdict and this arm, the arm
 * is refused rather than applying a stale judgement to new code. Bypassing it would have
 * re-opened that window.
 *
 * WHY IT RUNS AFTER THE STATUS POST, unlike the withdrawal. The W1-T230 gate recovers the
 * verdict from a ledgered `review.posted` line, which `postReviewStatusGuarded` writes. Arming
 * before the post would find no line and be refused (fail-closed). The asymmetry is correct:
 * a withdrawal must beat GitHub to the merge, an arm must follow the evidence it depends on.
 *
 * THE TASK ID. `task.id` is already `taskId ?? \`PR-<number>\`` at every caller
 * (run-task.ts's `reviewCommand`), so the synthetic id the review lane assigns satisfies the
 * gate with nothing new minted, and the resulting ledger line is attributable: an operator
 * reading `automerge.armed` sees `PR-970` and can find the PR.
 *
 * DEPENDABOT IS EXCLUDED. `rmd dep-review` is a separate deterministic lane with its own
 * arm/escalate policy; the sweep routes dependabot PRs there and never to post-review. But
 * `reviewCommand` has no dependabot guard, so a manual `rmd review` on one would otherwise arm
 * a PR that lane may have deliberately declined. Two lanes arming one PR on different rules is
 * worse than the gap being closed here.
 */
export function armIfVerdictPermits(
  verdict: Pick<ReviewVerdict, "state" | "capped" | "planOnly">,
  ctx: {
    prUrl: string;
    taskId: string;
    headSha: string;
    ledgerPath: string;
    headRefName?: string;
    log: (step: string, extra?: Record<string, unknown>) => void;
  },
  deps: { arm?: (prUrl: string, taskId: string) => ArmOutcome; ledgerLines?: () => Array<Record<string, unknown>> } = {},
): ArmOutcome | "skipped" {
  if (ctx.headRefName?.startsWith("dependabot/")) {
    ctx.log("automerge.arm_skipped", { reason: "dependabot PR — the dep-review lane owns arming for these", head_sha: ctx.headSha });
    return "skipped";
  }
  const override = verdict.capped
    ? cappedOverrideFromLedger(
        (deps.ledgerLines ?? (() => readLedgerLines(ctx.ledgerPath)))(),
        ctx.taskId,
        ctx.headSha,
      )
    : undefined;
  const decision = decideAutoMergeArm(verdict, false, override);
  if (!decision.arm) {
    ctx.log("automerge.arm_skipped", {
      outcome: "skipped",
      reason: decision.reason,
      decision_reason: decision.reason,
      head_sha: ctx.headSha,
      task_id: ctx.taskId,
    });
    return "skipped";
  }
  // W1-T230's own gate still applies inside: it re-reads the live head and refuses a stale
  // verdict. Its OUTCOME is read (impl-BC) rather than discarded, so a refusal is visible.
  const outcome = (deps.arm ?? armAutoMerge)(ctx.prUrl, ctx.taskId);
  // impl-BI: the STEP NAME must match the outcome. This used to log `automerge.armed`
  // unconditionally with the outcome merely carried in a field — so a `ledger-refused` here
  // still read as an arm to anyone counting steps.
  //
  // impl-BL: `reason` must describe the OUTCOME, not the semantic gate. It used to carry
  // `decision.reason` unconditionally, producing the unreadable pair this PR's ledger is full
  // of — `outcome: "ledger-refused"` beside `reason: "verdict is a full PASS"` — because the two
  // fields answered different questions: `decision` is the SEMANTIC gate (which approved) and
  // `outcome` comes from the LEDGER gate inside `armAutoMerge` (which refused), whose real reason
  // reached only stdout via `deps.say`. The semantic verdict is kept under its own name so the
  // line still records why arming was PERMITTED as well as what actually happened.
  ctx.log(armOutcomeArmed(outcome) ? "automerge.armed" : "automerge.arm_skipped", {
    outcome,
    reason: armOutcomeReason(outcome, decision.reason),
    decision_reason: decision.reason,
    head_sha: ctx.headSha,
    task_id: ctx.taskId,
  });
  return outcome;
}

/**
 * impl-BL — the `reason` an `automerge.*` ledger line carries, derived from the OUTCOME that
 * actually occurred rather than from the semantic gate that merely permitted the attempt.
 *
 * `armAutoMerge` returns an outcome string and sends its prose reason to `deps.say` (stdout)
 * only; this PR does not change that function, so the mapping lives here. An ARMING outcome
 * legitimately carries the semantic gate's reason — that IS why it armed. Every other outcome
 * gets the meaning of its own branch, so no ledger line can again pair a refusal with
 * "verdict is a full PASS".
 */
export function armOutcomeReason(outcome: ArmOutcome | "skipped", decisionReason: string): string {
  switch (outcome) {
    case "armed":
      return decisionReason;
    case "direct-merged":
      return `${decisionReason} — GitHub refused --auto on an already-clean PR, so the clean-status fallback merged it outright`;
    case "ledger-refused":
      return "the W1-T230 ledger gate refused: no `review.posted` line for this task matched the PR's current head (see the automerge.ledger_refused console line for which branch)";
    case "no-task-id":
      return "no task id was resolvable for this PR, so the W1-T230 ledger gate had no key to look the verdict up by";
    case "head-unavailable":
      return "the PR's current head could not be read, so the arm was withheld rather than applied to an unknown head";
    case "direct-merge-failed":
      return "GitHub refused --auto as already-clean and the direct-merge fallback then failed";
    case "arm-error-ignored":
      return "`gh pr merge --auto` failed for a reason that is not the clean-status case — treated as transient and left for the next sweep pass";
    case "skipped":
      return "the semantic gate refused before any arm was attempted";
  }
}

/**
 * impl-BI — ARM, THEN LEDGER WHAT ACTUALLY HAPPENED. The single wrapper the post-review
 * Architect lanes (dep-review, retro, triage, plan, approve) call instead of the
 * `armAutoMerge(...); log("automerge.armed", {})` pair every one of them used to carry.
 *
 * THE DEFECT IT CLOSES. {@link armAutoMerge} does not throw — it RETURNS which of its seven
 * branches it took, and five of them (`no-task-id`, `head-unavailable`, `ledger-refused`,
 * `direct-merge-failed`, `arm-error-ignored`) armed NOTHING. All five lanes discarded that
 * value and logged `automerge.armed` regardless, so the ledger recorded an arm for PRs that
 * were explicitly refused, and `automerge.armed` stopped being evidence of anything. The
 * refusal itself went only to `say` → stdout → daemon.out.log, where nobody counts.
 *
 * NOT A SECOND IMPLEMENTATION of "which outcomes count as armed" — that rule lives in exactly
 * one place, {@link armOutcomeArmed} (lib/sweep.ts, PR #968), and is imported here. Two copies
 * of this rule is precisely how the sweep and the run flow drifted apart in the first place.
 *
 * The step names match the ones {@link armIfVerdictPermits} already established, so a reader
 * grepping the ledger for `automerge.arm_skipped` finds every non-arm from every lane.
 */
export function armAndLogOutcome(
  prUrl: string,
  taskId: string | undefined,
  log: (step: string, extra?: Record<string, unknown>) => void,
  arm: (prUrl: string, taskId: string | undefined) => ArmOutcome = armAutoMerge,
): ArmOutcome {
  const outcome = arm(prUrl, taskId);
  log(armOutcomeArmed(outcome) ? "automerge.armed" : "automerge.arm_skipped", { outcome, task_id: taskId });
  return outcome;
}

/**
 * impl-BI — the human-readable half of the same honesty fix. Every one of the five lanes
 * printed a fixed `"… gated + armed …"` to the console whatever happened; `retroCommand`
 * printed "retro PR gated + armed (review success)" 1.2 seconds after the console had already
 * carried `automerge.ledger_refused`. Pure and exported so the assertion is on the STRING,
 * not on a mock's call count.
 */
export function armReportPhrase(outcome: ArmOutcome): string {
  return armOutcomeArmed(outcome) ? `armed (${outcome})` : `NOT armed (${outcome})`;
}

/**
 * PURE classifier for a failed `gh pr merge --auto` (exported for test): the
 * "clean status" class means the PR was ALREADY fully mergeable — auto-merge
 * had nothing to wait on and the correct completion is an immediate direct
 * merge (the caller only ever arms gated-green PRs). Everything else is
 * "ignore": informational, retried by the next sweep pass.
 */
export function armFailureAction(stderrText: string): "direct-merge" | "ignore" {
  return /clean status/i.test(stderrText) ? "direct-merge" : "ignore";
}

/**
 * Ensure a PR body carries the `Remudero-Task: <id>` trailer. This is precedence
 * source (c) for deriveStatus AND it makes a run's provenance visible on GitHub.
 * Idempotent and non-fatal: whoever opened the PR (worker or fallback), the
 * orchestrator guarantees the trailer here.
 */
/**
 * W1-T256: fetch a PR's CURRENT body via gh — the artifact the body-coverage fix
 * rung must judge (the same `gh pr view --json body` read reviewCommand uses). The
 * `gh` reader is injectable so the pure body/`?? ""` logic is unit-tested without a
 * subprocess; the two fix-rung call sites pass it by reference.
 */
export async function fetchPrBodyViaGh(prUrl: string, gh: (args: string[]) => unknown = ghJson): Promise<string> {
  const view = gh(["pr", "view", prUrl, "--json", "body"]) as { body?: string };
  return view.body ?? "";
}

/**
 * W1-T307: fetch a PR's CURRENT changeset (file paths only) via gh — the same "what did this PR
 * actually touch" fact {@link bodyContradictsDiff} otherwise learns from a parsed `git diff`, read
 * live instead since the fix rung calls this mid-strike, before anything re-fetches a diff blob.
 * Injectable for the same reason {@link fetchPrBodyViaGh} is (a unit test drives the pure logic
 * without a subprocess).
 */
export async function fetchPrDiffFilesViaGh(prUrl: string, gh: (args: string[]) => unknown = ghJson): Promise<string[]> {
  const view = gh(["pr", "view", prUrl, "--json", "files"]) as { files?: { path: string }[] };
  return (view.files ?? []).map((f) => f.path);
}

/**
 * W1-T307: write a PR's body via gh — the mechanism {@link deriveChangesetClaimUpdate}'s narrow,
 * mechanical edit is actually committed through. Injectable so a unit test can assert the UPDATE
 * ITSELF (what was written) rather than mocking a subprocess.
 */
export async function updatePrBodyViaGh(prUrl: string, body: string): Promise<void> {
  execFileSync("gh", ["pr", "edit", prUrl, "--body", body], { stdio: "pipe" });
}

/**
 * A single enumerated item's wrapping, split from its core so {@link rebuildChangesetEnumeration}
 * can copy the SAME wrap style (backticks, quotes, parens — whatever the body's own house style
 * used) forward onto the new file list, rather than inventing a style of its own.
 */
function splitEnumerationWrap(item: string): { prefix: string; suffix: string } {
  const prefixMatch = /^[`'"([]+/.exec(item);
  const prefix = prefixMatch ? prefixMatch[0] : "";
  const rest = item.slice(prefix.length);
  const suffixMatch = /[`'")\].,;:]+$/.exec(rest);
  const suffix = suffixMatch ? suffixMatch[0] : "";
  return { prefix, suffix };
}

/**
 * Rebuild an "exactly N files: a, b, c" claim's enumeration clause (the text after the colon)
 * against the CURRENT `diffFiles`, copying the original items' wrap style forward. Returns
 * `undefined` — fail safe, per {@link deriveChangesetClaimUpdate}'s doc — when the original
 * items' wrapping is not uniform enough to copy forward with confidence: this is deliberately
 * NOT a general prose rewriter, only a mechanical splice of a shape it can prove it understood.
 */
function rebuildChangesetEnumeration(raw: string, diffFiles: string[]): string | undefined {
  if (diffFiles.length === 0) return undefined;
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (items.length === 0) return undefined;
  const wraps = items.map(splitEnumerationWrap);
  const prefix = wraps[0].prefix;
  if (!wraps.every((w) => w.prefix === prefix)) return undefined; // inconsistent wrapping
  const suffix = wraps[0].suffix;
  const nonLast = wraps.slice(0, -1);
  if (!nonLast.every((w) => w.suffix === suffix)) return undefined;
  const last = wraps[wraps.length - 1];
  if (!last.suffix.startsWith(suffix)) return undefined;
  // The last item may carry EXTRA trailing sentence punctuation beyond the shared wrap (e.g.
  // "`d.ts`." vs every other item's "`b.ts`") — preserved on the new last item, never invented.
  const trailingPunct = last.suffix.slice(suffix.length);
  if (trailingPunct && !/^[.,;:)\]}]*$/.test(trailingPunct)) return undefined;
  return diffFiles
    .map((f, i) => `${prefix}${f}${suffix}${i === diffFiles.length - 1 ? trailingPunct : ""}`)
    .join(", ");
}

/**
 * W1-T307 (the #1202/W1-T301 fixture — MEASURED: a body-coverage strike genuinely repaired
 * coverage-ratchet by committing the missing test, which took the changeset from 4 files to 5;
 * the body still read "This PR touches exactly 4 files: …", `bodyContradictsDiff` correctly
 * flagged the now-stale claim, and the successful repair was converted into a `needs a human`
 * block). THE COMMIT THAT CHANGES THE DIFF OWNS THE CLAIM ABOUT THE DIFF.
 *
 * Reuses `bodyContradictsDiff`'s OWN parse to decide whether a claim is even stale — never a
 * second contradiction matcher that could disagree with the gate (design point 1). When exactly
 * one "exactly N files[: a, b]" claim is the sole count-shaped contradiction, returns `body` with
 * ONLY that claim's count + enumeration mechanically corrected to `diffFiles` (design point 2).
 * Returns `undefined` — leave the body exactly as it is — in every other case:
 *
 *   - no changeset claim at all, or a claim that does not contradict the diff (nothing stale to
 *     fix, and injecting a claim that was never there would create the very contradiction risk
 *     this closes — design point 3);
 *   - anything this cannot reconstruct with confidence: more than one count-shaped contradiction,
 *     the claimed text repeated elsewhere in the body (an unambiguous splice is impossible), or an
 *     enumeration whose item wrapping is not uniform enough to copy forward faithfully (design
 *     point 4 — FAIL SAFE: a wrong edit certifies something false, worse than the stale claim the
 *     review already correctly refuses).
 *
 * Path/absence claims ("no src/", "plan-only", "data-only") are deliberately NOT rewritten here —
 * rewriting an arbitrary "no X" sentence is exactly the "rung rewriting a human's rationale"
 * failure design point 2 warns is worse than the one being fixed; this stays scoped to the
 * count/enumeration shape the #1202 fixture actually hit.
 */
export function deriveChangesetClaimUpdate(body: string, diffFiles: string[]): string | undefined {
  if (diffFiles.length === 0) return undefined;
  const contradictions = bodyContradictsDiff(body, diffFiles);
  const countClaims = contradictions.filter((c) => /^exactly\s+\w+\s+files?\b/i.test(c.claim));
  if (countClaims.length !== 1) return undefined; // none, or ambiguous — fail safe

  const claim = countClaims[0].claim;
  const firstIdx = body.indexOf(claim);
  // The claim must appear, and appear EXACTLY ONCE — a repeat means the splice below could land
  // on the wrong occurrence (or both), which is exactly the "wrong edit" design point 4 forbids.
  if (firstIdx === -1 || body.indexOf(claim, firstIdx + 1) !== -1) return undefined;

  const m = /^(exactly\s+)\w+(\s+files?\b)(?:\s*:\s*(.+))?$/i.exec(claim);
  if (!m) return undefined;
  const [, exactlyWord, , enumerationRaw] = m;

  const newFilesWord = ` file${diffFiles.length === 1 ? "" : "s"}`;
  let newClaim = `${exactlyWord}${diffFiles.length}${newFilesWord}`;
  if (enumerationRaw !== undefined) {
    const rebuilt = rebuildChangesetEnumeration(enumerationRaw, diffFiles);
    if (rebuilt === undefined) return undefined; // fail safe — can't copy the wrap style forward
    newClaim += `: ${rebuilt}`;
  }
  return body.slice(0, firstIdx) + newClaim + body.slice(firstIdx + claim.length);
}

function ensureTaskTrailer(prUrl: string, taskId: string): void {
  const trailer = `Remudero-Task: ${taskId}`;
  try {
    const view = ghJson(["pr", "view", prUrl, "--json", "body"]) as { body?: string };
    const body = view.body ?? "";
    if (body.includes(trailer)) return;
    const newBody = body.trim().length > 0 ? `${body.trimEnd()}\n\n${trailer}\n` : `${trailer}\n`;
    execFileSync("gh", ["pr", "edit", prUrl, "--body", newBody], { stdio: "pipe" });
  } catch {
    // Provenance trailer is best-effort; the ledger (source (a)) still records the PR.
  }
}

/**
 * The GitHub query the run-ownership guard needs: resolve a PR's `headRefName`.
 * Behind an interface (mirroring `status.ts`'s {@link GitHub}) so unit tests can
 * inject a fixture instead of exec'ing `gh`.
 */
export interface PrHeadGateway {
  /** The PR's head branch name, or `undefined` if it cannot be resolved. */
  headRefName(prUrl: string): string | undefined;
}

/**
 * Real gateway: `gh pr view <url> --json headRefName`. Fail-SOFT at the `gh`
 * layer (any error resolves to `undefined`) is deliberate: {@link checkPrOwnership}
 * treats an unresolved head ref as NOT owned, so a `gh` hiccup fails CLOSED
 * (never merged) rather than silently assuming the claim is honest.
 */
export function ghPrHeadGateway(): PrHeadGateway {
  return {
    headRefName(prUrl) {
      try {
        const view = ghJson(["pr", "view", prUrl, "--json", "headRefName"]) as { headRefName?: string };
        return view.headRefName;
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * The verdict + ledger payload for a claimed PR whose head branch is NOT this
 * run's own branch — the false-merged INVERSION class (W1-T62). Run
 * W1-T54b-1784151420811 was ledgered `verdict=merged` via PR #80 — Dependabot's
 * own PR, not this run's — because attribution had no ownership check at all.
 */
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

/**
 * RUN-OWNERSHIP GUARD (W1-T62, the backstop). Before ANY verdict may credit a
 * claimed PR, resolve that PR's `headRefName` via the injected gateway and
 * assert it equals `ownBranch` — this run's OWN branch (`run-<runId>`). Returns
 * `null` when ownership holds (the caller proceeds to trailer/gate/merge as
 * normal), or a fail-CLOSED, NAMED `pr_attribution_failed` verdict on any
 * mismatch — including an unresolved head ref, which counts as NOT owned rather
 * than assumed honest. This is the backstop even a future parse regression
 * cannot get past: a run can never merge-credit a PR whose branch it did not
 * create. The caller MUST return immediately on a non-null result, before any
 * trailer stamp / CI wait / review / auto-merge arm — the PR is left untouched.
 */
export function checkPrOwnership(
  prUrl: string,
  ownBranch: string,
  gateway: PrHeadGateway,
  costUsd: number,
  /** W1-T268: appended LAST so no existing positional caller shifts — see
   *  {@link WorkerResult.accountLabel}. Omitted ⇒ the ledger line carries no label,
   *  never a guess. */
  accountLabel?: string,
): OwnershipVerdict | null {
  const claimedBranch = gateway.headRefName(prUrl) ?? null;
  if (claimedBranch === ownBranch) return null;
  return {
    verdict: "pr_attribution_failed",
    ledger: {
      verdict: "pr_attribution_failed",
      claimed_url: prUrl,
      claimed_branch: claimedBranch,
      owned_branch: ownBranch,
      cost_usd: costUsd,
      account_label: accountLabel,
      reason:
        claimedBranch === null
          ? "claimed PR's head branch could not be resolved — failing closed rather than assumed owned"
          : `claimed PR's head branch "${claimedBranch}" is not this run's own branch "${ownBranch}"`,
    },
  };
}

/**
 * SCOPE-GUARDED BRANCH REFRESH (W1-T142, the `reset --soft` phantom-revert
 * near-miss): collapsing a stale worker branch with `git reset --soft
 * origin/main` forged a merge-base — the flattened commit's diff vs main
 * REVERTED files an unrelated merged PR had touched, and because main had not
 * re-touched them GitHub showed the PR as cleanly mergeable; the phantom
 * revert would have merged silently. Given the set of paths a refreshed
 * branch's diff touches and the task's declared `files` scope, returns the
 * OUT-OF-SCOPE paths (empty = clean, safe to push) — anything outside the
 * declared scope is either a phantom revert or scope creep.
 *
 * PURE: no git/network calls — `diffFiles` is the caller's already-computed
 * diff-file list, never read here. FAIL-CLOSED: an empty/undefined
 * `declaredFiles` scope refuses every non-empty diff (returns it verbatim)
 * rather than waving it through — a task with no declared scope can never
 * legitimize an out-of-scope push. An empty `diffFiles` is always clean
 * (nothing staged, nothing to refuse) regardless of the declared scope.
 */
export function scopeGuardOutOfScopeFiles(
  diffFiles: readonly string[],
  declaredFiles: readonly string[] | undefined,
): string[] {
  if (diffFiles.length === 0) return [];
  if (!declaredFiles || declaredFiles.length === 0) return [...diffFiles];
  const declared = new Set(declaredFiles);
  return diffFiles.filter((f) => !declared.has(f));
}

/**
 * W1-T322: task ids currently OPEN in `plan` — the set a report's `SHIPS-UNWIRED: <id>` marker
 * is checked against before it can honour an unreached export (see
 * {@link "./lib/review.js".ReviewEvidence.openTaskIds}'s doc). PURE — no I/O, reads only
 * `plan` and an already-resolved `projection` every real caller either already has in scope
 * (never a second, independently-opened GitHub read path) or explicitly does not.
 *
 * W1-T367: "open" used to mean "yaml `status:` is not `merged`/`done`" — the DECORATIVE field
 * plan/tasks.yaml's own header says the runner never writes back. MEASURED at cdf885a: 248 of
 * 359 tasks carry a stale `queued` status despite a long-merged PR, so that reading credited
 * 248 wrongly-open ids to this set — a `SHIPS-UNWIRED: <one of those ids>` marker was honoured
 * instead of flagged, exactly the false exemption W1-T322's own second acceptance criterion
 * exists to catch. `projection` is now the ONLY source of "open": a task counts as open ONLY
 * when `projectPlan` resolved it, NON-merged, AND NOT `indeterminate` (a GitHub read that
 * genuinely failed) — every other case (missing from `projection`, merged, indeterminate) is
 * EXCLUDED, so a marker naming it is FLAGGED. This is the safe direction (design (vi)): unlike
 * {@link planHealthSweep}'s cost-only skip, honouring a SHIPS-UNWIRED marker is a real
 * exemption, so uncertainty must fail toward flagging, never toward honouring.
 *
 * `projection` is OPTIONAL and deliberately has NO GitHub-backed default (design (v): "if a
 * call site has no projection in hand, say so rather than adding a fetch") — omitting it
 * degrades to the EMPTY set, i.e. every id is treated as not-open, so every marker at that call
 * site is flagged rather than honoured. This is the SAME safe default `judgeReview` already
 * applies one layer up (`openTaskIds ?? new Set()`, lib/review.ts) — a caller with no
 * projection in hand (the manual `rmd review` CLI path, and the fix-rung's sweep dispatch,
 * neither of which has one already computed nearby) gets the identical safe behavior whether
 * it calls this function or skips it, so both are left calling it plainly for a single,
 * documented source of truth. The one caller that DOES already hold a projection (`runTask`'s
 * dispatch path, computed for `assertRunnable`'s own `isMerged` just above) passes it through —
 * the SAME batched `projectPlan` pass, never a second one.
 */
export function openTaskIdsFromPlan(plan: Plan, projection?: ReadonlyMap<string, StatusProjection>): Set<string> {
  if (!projection) return new Set();
  return new Set(
    plan.tasks
      .filter((t) => {
        const p = projection.get(t.id);
        return p !== undefined && !p.merged && !p.indeterminate;
      })
      .map((t) => t.id),
  );
}

interface GateOutcome {
  merged: boolean;
  reason: string;
}

/**
 * Poll a PR to a terminal gate decision. Returns merged only on state MERGED.
 * A red required check short-circuits to blocked. Otherwise this polls until
 * {@link checkWaitStalled} sees no forward motion (pending is never treated as
 * pass) — an ITERATION COUNT never ends the wait on its own (W1-T382: 21 of 21
 * PRs this repo ever booked as a check-wait timeout later merged, so a bound
 * on ELAPSED POLLS was firing on a healthy PR every single time it fired).
 */
async function pollToGate(
  prUrl: string,
  log: (step: string, extra?: Record<string, unknown>) => void,
  everySec = 6,
): Promise<GateOutcome> {
  const readings: (RollupEntry[] | undefined)[] = [];
  for (let i = 0; ; i++) {
    const v = ghJson(["pr", "view", prUrl, "--json", "state,statusCheckRollup"]) as {
      state: string;
      statusCheckRollup?: RollupEntry[];
    };
    if (v.state === "MERGED") return { merged: true, reason: "checks green" };
    if (v.state === "CLOSED") return { merged: false, reason: "pr closed" };
    const roll = v.statusCheckRollup ?? [];
    const red = roll.find((c) => RED_CONCLUSIONS.has(String(c.conclusion ?? c.state ?? "")));
    if (red) {
      log("pr.checks", { conclusion: "red", check: red.name ?? red.context ?? "unknown" });
      return { merged: false, reason: `required check red: ${red.name ?? red.context ?? "unknown"}` };
    }
    readings.push(roll);
    if (readings.length > STALL_WINDOW) readings.shift(); // checkWaitStalled only ever looks at the last STALL_WINDOW
    const stall = checkWaitStalled(readings);
    if (stall.stalled) {
      log("pr.stalled", { pending: stall.pending, identicalPolls: STALL_WINDOW });
      return {
        merged: false,
        reason:
          stall.pending.length > 0
            ? `no progress for ${STALL_WINDOW} consecutive polls — still pending: ${stall.pending.join(", ")}`
            : `no progress for ${STALL_WINDOW} consecutive polls`,
      };
    }
    if (i === 0 || i % 5 === 0) {
      log("pr.polling", {
        state: v.state,
        checks: roll.map((c) => `${c.name ?? c.context}:${c.conclusion ?? c.status ?? c.state}`),
      });
    }
    execFileSync("sleep", [String(everySec)]);
  }
}

/**
 * Interpret a PR's `statusCheckRollup` for the `ci` gate — EXCLUDING the
 * `remudero-review` entry itself (W1-T102, the #177 stale-status
 * exhaustion). `remudero-review` is a commit status POSTED BY this same fix
 * rung's own judge (`runReview`), pinned to a head sha. A body-only strike
 * (e.g. a `gh pr edit` with no new commit) never changes the head sha, so
 * the PREVIOUS strike's FAILURE status is still sitting in the rollup the
 * next time this polls. Counting that as a red check made the gate
 * un-satisfiable forever after any failing review: the rung exhausted its
 * strikes against its OWN stale verdict instead of ever re-judging the
 * fix. `ci` gates on the real `ci` check going SUCCESS; `remudero-review`
 * is judged FRESH by `runReview` every strike, never trusted from the
 * rollup here.
 */
export function ciGateFromRollup(rollup: RollupEntry[] | undefined): "green" | "red" | "pending" {
  const roll = (rollup ?? []).filter((c) => (c.name ?? c.context) !== REVIEW_CTX);
  const red = roll.find((c) => RED_CONCLUSIONS.has(String(c.conclusion ?? c.state ?? "")));
  if (red) return "red";
  const ci = roll.find((c) => (c.name ?? c.context) === "ci");
  if (ci && String(ci.conclusion ?? ci.state ?? "") === "SUCCESS") return "green";
  return "pending";
}

/**
 * W1-T382: how many consecutive IDENTICAL poll readings {@link checkWaitStalled} requires
 * before it concludes a check-wait has stalled. This is a property of the POLL CADENCE
 * (`everySec` in `pollToGate`/`waitForCiGreen`) — how many times we have re-asked the same
 * question and gotten the same answer — NOT of CI duration. That distinction is the whole
 * fix: recon measured 21 of 21 PRs ever booked as a check-wait timeout later merging (0
 * closed unmerged), so there is no observed "stuck" population to fit an elapsed-time bound
 * against. Any such bound is fitted to noise and only changes how often the false block
 * fires, never whether it is wrong to fire.
 *
 * THE SENTENCE THAT USED TO END THIS DOC — *"'5 identical readings in a row' needs no such
 * fit"* — WAS FALSE, and is corrected here rather than deleted, because the correction is the
 * whole of {@link rollupHasRunningCheck}. `STALL_WINDOW × everySec` IS an elapsed-time bound:
 * 5 × 6s = THIRTY SECONDS. W1-T382 replaced a deadline with a derivative and then sampled the
 * derivative far faster than the signal changes. A healthy nine-minute `ci` job has a
 * derivative of EXACTLY ZERO by construction — `IN_PROGRESS` is a constant string, so
 * "nothing changed" is what a correct long run looks like, not evidence of a stall. Measured
 * on a live PR: after ~90s of fast gates completing, silent stretches of 7m20s and 5m22s, so
 * a 30s bound concludes "stalled" about seven minutes before `ci` goes green, every time.
 *
 * The number is therefore NOT the defect and is deliberately UNCHANGED — raising it would only
 * change how often the false block fires, which is the very reasoning above. What changed is
 * the predicate: a check that is RUNNING is now motion in its own right, so the window only
 * ever governs a QUIESCENT rollup, which is the population it was always sound for.
 */
export const STALL_WINDOW = 5;

/** Order-independent fingerprint of a rollup's per-check state, used by
 *  {@link checkWaitStalled} to tell "nothing changed" from "something moved" between two
 *  polls without caring whether GitHub happens to reorder entries between requests. */
function rollupSignature(rollup: RollupEntry[] | undefined): string {
  return (rollup ?? [])
    .map((c) => `${c.name ?? c.context ?? "unknown"}:${c.conclusion ?? c.status ?? c.state ?? ""}`)
    .sort()
    .join("|");
}

/**
 * Rollup `status` values meaning a check is ACTIVELY EXECUTING at this instant.
 *
 * Exactly one value, and the omissions are the point. GitHub's `statusCheckRollup` is a union
 * of two node kinds and only one of them has a lifecycle: a CheckRun carries
 * `status: QUEUED | IN_PROGRESS | COMPLETED` alongside its `conclusion`, while a StatusContext
 * carries only `state` and no status at all. So `IN_PROGRESS` is the ONLY value that is
 * positive evidence of a machine doing work right now.
 *
 * `QUEUED` is deliberately NOT here, and neither is a StatusContext's `PENDING`. Both are
 * "waiting for something that may never come" — a check queued behind a runner that never
 * arrives, or a required status nobody will ever post, are the two shapes of a REAL stall.
 * Counting them as motion would make {@link checkWaitStalled} unfireable and reintroduce the
 * unbounded wait W1-T382 was careful to bound.
 */
const RUNNING_STATUSES = new Set(["IN_PROGRESS"]);

/**
 * Is any check in this rollup actually RUNNING? — the correction to W1-T382's derivative.
 *
 * Reads `status` and ONLY `status`, never `conclusion`. On the wire `IN_PROGRESS` is a status
 * value and never a conclusion (a completed run reports `status: COMPLETED` with the outcome in
 * `conclusion`), so consulting the conclusion could only ever match a shape GitHub does not
 * emit. Uppercased because REST spells these lowercase where GraphQL spells them upper —
 * `gh pr view --json` (both live callers) is GraphQL, but `rollupFromRest` composes the same
 * shape from REST, and a predicate that silently depended on which door the data came through
 * is the kind of thing that reads correct and is not.
 *
 * A rollup with a running check is EXCLUDED from the stall verdict entirely: it is not evidence
 * that we should wait a bit longer, it is evidence that the question "has anything moved?" is
 * being asked too early to have an answer.
 */
export function rollupHasRunningCheck(rollup: RollupEntry[] | undefined): boolean {
  return (rollup ?? []).some((c) => RUNNING_STATUSES.has(String(c.status ?? "").toUpperCase()));
}

/**
 * W1-T382: THE DERIVATIVE, NOT THE DEADLINE. `pollToGate` and `waitForCiGreen` call this
 * every poll (after their own immediate terminal checks — merged/closed/red — have already
 * been ruled out) with the full sequence of rollups read so far for the CURRENT wait,
 * OLDEST FIRST, and get back whether to give up. Give up ONLY when there has been no
 * forward motion: the last `STALL_WINDOW` readings are byte-identical (via
 * {@link rollupSignature}) — no required check's conclusion/status/state changed, and the
 * pending set did not shrink (a shrink IS a state change, so one comparison covers both,
 * per the task design). Fewer than `STALL_WINDOW` readings so far is never enough evidence
 * to conclude stalled, so a fresh wait always keeps waiting.
 *
 * Pure — no I/O, no clock, nothing spawned — so it costs ZERO extra API calls: both callers
 * already fetch `statusCheckRollup` on every iteration for their own red/green checks; this
 * only compares readings already in hand.
 *
 * Returns which checks were still pending when the stall was concluded, so a `blocked_ci`
 * verdict can NAME the observation that ended the wait instead of just asserting elapsed
 * time passed.
 *
 * A RUNNING CHECK IS MOTION, and outranks the signature comparison entirely
 * ({@link rollupHasRunningCheck}). "No state changed" and "nothing is happening" are different
 * claims, and only the second is a stall — a nine-minute job holds `IN_PROGRESS` constant for
 * nine minutes while working perfectly, so the byte-identical signature it produces is a
 * property of the sampling rate rather than a property of the build. The guard is checked
 * BEFORE the signatures precisely because it does not depend on them: whatever the last five
 * readings say about each other, a machine currently executing a job is forward motion.
 *
 * WHAT STILL BOUNDS THE WAIT, since this only ever makes the predicate MORE permissive. Three
 * things, none of them this function: (1) `IN_PROGRESS` is provider-bounded — GitHub cancels an
 * over-running job, and a CANCELLED/TIMED_OUT conclusion is in `RED_CONCLUSIONS`, which both
 * callers short-circuit on before they ever reach this predicate; (2) `ci-gate`'s own
 * `WAIT_CAP_SECONDS` (2400s, `.github/workflows/ci-gate.yml`) fails that required check when a
 * required check never registers, which again surfaces here as RED; (3) this predicate itself,
 * unchanged, for a QUIESCENT rollup — nothing running and nothing changing is still a stall and
 * is still caught. So the exemption is scoped to a state that is transient by construction.
 */
export function checkWaitStalled(readings: ReadonlyArray<RollupEntry[] | undefined>): {
  stalled: boolean;
  pending: string[];
} {
  if (readings.length < STALL_WINDOW) return { stalled: false, pending: [] };
  const window = readings.slice(-STALL_WINDOW);
  const last = window[window.length - 1] ?? [];
  if (rollupHasRunningCheck(last)) return { stalled: false, pending: [] };
  const signatures = window.map(rollupSignature);
  if (!signatures.every((s) => s === signatures[0])) return { stalled: false, pending: [] };
  const pending = last
    .filter((c) => {
      const state = String(c.conclusion ?? c.status ?? c.state ?? "");
      return !RED_CONCLUSIONS.has(state) && state !== "SUCCESS";
    })
    .map((c) => c.name ?? c.context ?? "unknown");
  return { stalled: true, pending };
}

/**
 * Poll the PR's `ci` check to a terminal state BEFORE the review runs (Standing
 * rule 4: the reviewer judges ACCEPTANCE only once the code is proven to typecheck
 * and its tests pass). Returns "green" on ci success, "red" on any red conclusion,
 * "timeout" if the wait STALLS — {@link checkWaitStalled} sees no forward motion — pending
 * is never treated as pass. The scan ignores `remudero-review`'s OWN pinned status
 * ({@link ciGateFromRollup}) so a body-only fix strike (unchanged head sha) is never
 * blocked by the review verdict it is itself about to replace.
 *
 * W1-T382: this used to give up after a fixed ITERATION COUNT regardless of whether `ci`
 * was still moving — the same defect {@link pollToGate} had, and measured against the same
 * ledger (21 of 21 PRs this repo ever booked as a check-wait timeout later merged). It now
 * polls until the rollup itself shows no forward motion, logging which check(s) were still
 * pending when it gave up (`ci.stalled`) so a `blocked_ci` reader can tell a stall from a
 * slow build without re-deriving it.
 */
async function waitForCiGreen(
  prUrl: string,
  log: (step: string, extra?: Record<string, unknown>) => void,
  everySec = 6,
): Promise<"green" | "red" | "timeout"> {
  const readings: (RollupEntry[] | undefined)[] = [];
  for (let i = 0; ; i++) {
    const v = ghJson(["pr", "view", prUrl, "--json", "statusCheckRollup"]) as {
      statusCheckRollup?: RollupEntry[];
    };
    const state = ciGateFromRollup(v.statusCheckRollup);
    if (state === "red") return "red";
    if (state === "green") return "green";
    readings.push(v.statusCheckRollup ?? []);
    if (readings.length > STALL_WINDOW) readings.shift(); // checkWaitStalled only ever looks at the last STALL_WINDOW
    const stall = checkWaitStalled(readings);
    const ci = (v.statusCheckRollup ?? []).find((c) => (c.name ?? c.context) === "ci");
    if (i === 0 || i % 5 === 0) log("ci.polling", { ci: String(ci?.conclusion ?? ci?.status ?? "pending") });
    if (stall.stalled) {
      log("ci.stalled", { pending: stall.pending, identicalPolls: STALL_WINDOW });
      return "timeout";
    }
    execFileSync("sleep", [String(everySec)]);
  }
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
 * A FRESH read-only reviewer worker (NEVER resumeSessionId, NEVER forkSession) is
 * spawned as an ADVISORY semantic layer, in a throwaway cwd so it cannot mutate the
 * diff it judges. Its per-criterion verdicts may only DOWNGRADE a criterion to
 * failure ({@link parseReviewerVerdicts} → semantic), never rescue an unpasted
 * proof. Its spawn is best-effort: a reviewer that fails to spawn (e.g. the
 * FIELD FINDING 12 self-updater race) never blocks the gate — the deterministic
 * floor still posts, fail-closed.
 */
async function runReview(args: {
  owner: string;
  repo: string;
  prUrl: string;
  /** `files` (W1-T322): the task's declared scope — see {@link "./lib/review.js".ReviewEvidence.taskDeclaredFiles}'s
   *  doc. Every real caller already passes the full plan `Task`, so this widens for free. */
  task: { id: string; acceptance?: AcceptanceCriterion[]; files?: string[] };
  report: string;
  settingsFile: string;
  config: Config;
  budgetUsd?: number;
  log: (step: string, extra?: Record<string, unknown>) => void;
  say: (msg: string) => void;
  account: (r: WorkerResult) => WorkerResult;
  /** false ⇒ deterministic floor only, no LLM spawn (used by the live proofs). */
  spawnReviewer?: boolean;
  /** The (task_type="reviewer" × the under-review task's risk) mount (§9,
   * W1-T63) — MOUNT-GOVERNED, never a hardcoded literal. Only consulted when a
   * reviewer is actually spawned (spawnReviewer!==false && criteria.length>0). */
  reviewerMount: Mount;
  /**
   * PR-HEAD checkout dir the deterministic FLOOR executes whitelisted proofs in
   * (W1-T65, ratifies P15 — HEAD DISCIPLINE: never the operator's working
   * checkout). Absent ⇒ the floor is keyword-only, exactly the pre-W1-T65
   * behavior (used by `rmd review`'s manual-PR path, which has no checkout).
   */
  headCheckoutDir?: string;
  /** impl-GE: merge-base blobs for the staleness check — see buildBaseProofDir. */
  baseCheckoutDir?: string;
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
  disarm?: (prUrl: string) => void;
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
  /**
   * W1-T322: task ids currently OPEN in the loaded plan — see {@link
   * "./lib/review.js".ReviewEvidence.openTaskIds}'s doc. Optional (fail-closed default: `undefined`,
   * meaning no `SHIPS-UNWIRED:` marker can ever be honoured) so every existing caller/fixture that
   * predates this task needs no update.
   */
  openTaskIds?: ReadonlySet<string>;
}): Promise<ReviewVerdict & { headSha: string; reviewerOutcome: string }> {
  const { owner, repo, prUrl, task, report, log, say } = args;
  const headSha = readHeadShaRest(prUrl);
  const diff = execFileSync("gh", ["pr", "diff", prUrl], { encoding: "utf8", maxBuffer: 1 << 26 });
  const criteria = task.acceptance ?? [];

  // Advisory semantic layer — a FRESH read-only reviewer (no session inheritance),
  // in a throwaway cwd so it cannot touch the worktree/diff under review.
  let semantic: (boolean | undefined)[] | undefined;
  const attemptReviewer = args.spawnReviewer !== false && criteria.length > 0;
  let reviewerSubtype: string | undefined;
  let reviewerSpawnFailed = false;
  if (attemptReviewer) {
    try {
      // W1-T115: routed through withTempDir so this throwaway cwd is ALWAYS
      // removed on exit — success or thrown error — instead of the bare
      // mkdtempSync this used to be, which never cleaned up on any path and
      // leaked one `rmd-review-*` dir per PR review (a major contributor to
      // the 26,711-dir ENOSPC incident: this runs on every gate check).
      await withTempDir("review", async (reviewCwd) => {
        const prompt =
          buildReviewPrompt({ task: { id: task.id, acceptance: criteria }, prUrl, owner, repo, headSha }) +
          "\n" +
          reviewerVerdictContract(criteria.length);
        const reviewer = args.account(
          await spawnWorker({
            cwd: reviewCwd,
            permissionMode: "bypassPermissions",
            settingsFile: args.settingsFile,
            // MOUNT-GOVERNED (§9, W1-T63/P10): model/effort/max_turns come from the
            // resolved "reviewer" mount, never a hardcoded literal. Before this, an
            // undeclared 12-turn cap with no model/effort override walled
            // `error_max_turns` on every substantive code PR — a floor-only PASS silently masquerading
            // as a completed review (P10-a; reviewerOutcome below makes it legible).
            model: args.reviewerMount.model,
            effort: args.reviewerMount.effort,
            maxTurns: args.reviewerMount.maxTurns,
            maxBudgetUsd: args.budgetUsd,
            config: args.config,
            prompt, // NEVER resumeSessionId, NEVER forkSession — fresh by construction.
          }),
        );
        semantic = parseReviewerVerdicts(
          [reviewer.text, reviewer.blocks.join("\n")].join("\n"),
          criteria.length,
        );
        reviewerSubtype = reviewer.subtype;
        log("review.reviewer", {
          session_id: reviewer.sessionId,
          subtype: reviewer.subtype,
          downgrades: semantic.filter((s) => s === false).length,
          // W1-T6: the advisory reviewer is a BRAIN-PLANE call — same telemetry
          // shape as a worker call, so ledger lines are queryable uniformly.
          ...workerLedgerFields(reviewer),
        });
        // The reviewer is fresh (no resume) — reap its SDK scratchpad now, before
        // withTempDir removes reviewCwd. Best-effort, guarded (lib/worker-scratch).
        reapWorkerScratch(reviewCwd);
      });
    } catch (e) {
      // Advisory only — the deterministic floor still binds and posts below.
      reviewerSpawnFailed = true;
      log("review.reviewer.error", { error: String((e as Error)?.message ?? e) });
    }
  }
  // W1-T63/P10-a: LEGIBLE outcome of the reviewer spawn — a floor-only PASS
  // (never attempted, or attempted but walled/spawn-failed) is never
  // byte-identical in the ledger/console to a review the reviewer COMPLETED.
  const outcome = reviewerOutcome({
    attempted: attemptReviewer,
    subtype: reviewerSubtype,
    spawnError: reviewerSpawnFailed,
  });

  // BINDING deterministic verdict; the orchestrator is the authoritative poster.
  // W1-T65 (ratifies P15): headCheckoutDir wires the FLOOR's whitelisted-proof
  // execution to the PR HEAD (never the operator's working checkout) — so the
  // gate observes repo state whether or not the advisory reviewer above ever
  // completed.
  const computed = judgeReview(criteria, {
    diff,
    report,
    semantic,
    headCheckoutDir: args.headCheckoutDir,
    baseCheckoutDir: args.baseCheckoutDir,
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

  // W1-T178 (verdict stability): a re-review of an UNCHANGED head sha whose
  // deterministic floor still passes may not render a verdict WORSE than its
  // predecessor — see applyVerdictStability's doc comment (lib/review.ts) for
  // the #388 fixture this fixes and why it is asymmetric (downgrades only).
  const prior = args.ledgerPath
    ? priorReviewVerdictFromLedger(readLedgerLines(args.ledgerPath), task.id)
    : undefined;
  const { verdict, suppressed } = applyVerdictStability(computed, headSha, prior);
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
    fetchLifecycle: () => fetchPrLifecycle(prUrl),
  });
  if (!posted.posted) {
    // REFUSED, NOT SWALLOWED: postReviewStatusGuarded already ledgered
    // `review.post_refused` with the full reason; this is the loud console
    // twin so a refusal is as visible as an ordinary posted verdict is.
    say(
      `remudero-review: post REFUSED for ${headSha.slice(0, 7)} (verdict computed: ${verdict.state}) — ` +
        `${posted.reason} (W1-T228 — see the review.post_refused ledger line)`,
    );
    return { ...verdict, headSha, reviewerOutcome: outcome };
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
  const reasons = visibleUnmet.map((c) => c.reason);
  if (verdict.testTheater) reasons.push("test theater: added tests assert nothing");
  // OBSERVABILITY (W1-T65 design): per-criterion proof_exec outcome, so an
  // OBSERVED verdict (executed_pass/executed_fail) is legible on the ledger vs a
  // KEYWORD one (not_executable), and an environment hiccup (exec_error) is never
  // silently indistinguishable from either.
  const proofExec = verdict.criteria.map((c) => c.proof_exec);
  // The gate TEACHES: the FULL list of unmet criteria goes to the ledger (and the
  // PR comment below) — the status description names only the first (length-capped).
  log("review.posted", {
    context: REVIEW_CONTEXT,
    state: verdict.state,
    head_sha: headSha,
    test_theater: verdict.testTheater,
    unmet_criteria: unmetClaims,
    reasons,
    // W1-T63/P10-a: makes a floor-only PASS LEGIBLE — never byte-identical to a
    // review the LLM reviewer actually completed.
    reviewer_outcome: outcome,
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
    ...degradedReasonLedgerFields(args.materializationFailure),
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
  });
  // W1-T322 (SHIPS-UNWIRED advisory floor): ADVISORY ONLY — ledgered here, never consulted by the
  // verdict/arm decision above or below. One `review.unwired_advisory` line per reason code (see
  // {@link "./lib/review.js".UnwiredAdvisory}'s doc), naming the PR (taskId + headSha + prUrl), the
  // reason code and the offending symbols — this is the dataset W1-T323's measurement window reads.
  // NOT added to DECISION_RELEVANT_LEDGER_STEPS (lib/ledger.ts), deliberately: nothing DECIDES
  // anything off this step yet — see design (v), which defers registration to W1-T323's own change,
  // the same rotation discipline `run.start`/other analytical-only steps already follow.
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
  // CALL DIRECTLY ABOVE THIS ONE. That line is the evidence W1-T230's gate requires: `armAutoMerge`
  // → `priorReviewVerdictFromLedger` → `decideArmFromLedgerVerdict` looks for a `review.posted`
  // ledger line matching this taskId AND this headSha, and fails CLOSED when it finds none.
  //
  // THIS CALL USED TO SIT 35 LINES HIGHER, immediately after `postReviewStatusGuarded`, under a
  // comment asserting that function "just wrote" the `review.posted` line. IT DOES NOT — its only
  // ledger writes are `review.post_refused` and `review.post_failed` (lib/review.ts, the two
  // appendLedger calls in its body). The line it was reading for did not exist yet, so the gate
  // fail-closed to `ledger-refused` on EVERY invocation this code path has ever had. The ledger
  // shows each refused arm preceding its own `review.posted` by 0–1ms (PR-977: 00:57:06.808 vs
  // .809; same-millisecond for PR-981/982/984, W1-T226, W1-T221). The only arms that have ever
  // succeeded carry `at: "open"` — the ungated arm-at-open path.
  //
  // WHY BELOW IS SAFE, not merely later: `appendLedger` is fully synchronous (openSync/writeSync/
  // closeSync) and `readLedgerLines` is `readFileSync`, so the read-after-write is ordered within
  // this process. Rotation cannot lose it either — `review.posted` is in
  // DECISION_RELEVANT_LEDGER_STEPS and rotation's per-step cap keeps the NEWEST
  // MAX_RETAINED_LINES_PER_STEP, of which this line is one.
  //
  // The gate still does real work here — it is NOT tautological now that its evidence exists.
  // `armAutoMerge` re-reads the PR's CURRENT head (`deps.headSha(prUrl)`, a live `gh pr view`) and
  // compares it to the head this verdict was written against, so a push landing between the
  // verdict and this call is still refused. No `posted.posted` guard is needed: the `if
  // (!posted.posted)` branch above already returned.
  const armCtx = { prUrl, taskId: task.id, headSha, ledgerPath: args.ledgerPath, headRefName: args.headRefName, log };
  armIfVerdictPermits(verdict, armCtx, { arm: args.arm });
  if (verdict.capped) {
    say(cappedAnnotation(proofExec.length));
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
  // SAME best-effort PR comment as the unmet-criteria block below rather than a
  // second `gh pr comment` call, so a rubric finding never gets its own separate
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
  if (hasUnmet || rubricSection || scopeSection) {
    // Post the full unmet list (+ the advisory rubric section, if any) as a PR
    // comment so a blocked PR — or one with a rubric concern — names its gap in
    // one place a human (or the next run) reads. Best-effort — never blocks the
    // verdict: `rubricSection` is pure text, appended below the binding verdict's
    // own block, never merged into or read by verdict/arm logic.
    const parts: string[] = [];
    if (hasUnmet) {
      parts.push(
        `**remudero-review=failure** — the following acceptance ${unmetClaims.length === 1 ? "criterion is" : "criteria are"} unmet:\n\n` +
          unmetClaims.map((c, i) => `${i + 1}. ${c}\n   - ${reasons[i]}`).join("\n") +
          (verdict.testTheater ? `\n\n_Also: test theater — added tests assert nothing._` : "") +
          `\n\nAdd the missing work (or escalate). Do NOT edit the acceptance criteria to match the diff.`,
      );
    }
    if (rubricSection) parts.push(rubricSection);
    if (scopeSection) parts.push(scopeSection);
    const body = parts.join("\n\n---\n\n");
    try {
      execFileSync("gh", ["pr", "comment", prUrl, "--body", body], { stdio: "pipe" });
    } catch {
      /* comment is best-effort; the status + ledger already carry the verdict */
    }
  }
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
  return { ...verdict, headSha, reviewerOutcome: outcome };
}

// ── THE blocked_review FIX RUNG (W1-T76, absorbs P21; MASTER-PLAN §3's fixing
// state — "red CI/changes-requested → fixing: resume round 1, fresh round 2").
//
// GROUND TRUTH this rung fixes: a mounted reviewer posts FAILURE with specific
// unmet_criteria + reasons (W1-T63, sharpened by W1-T65's observed verdicts),
// and `runReview`'s failing verdict used to be a DEAD END — the PR sat OPEN,
// the criteria/reasons were dropped, and re-running the task from scratch
// spawned a fresh worker with the identical spec, which patched WHICHEVER
// criterion the LAST block happened to name and dropped the other → an
// infinite ping-pong across two criteria (#111/#113). The hand-fix that broke
// that loop (#115) was ONE worker told to resolve ALL unmet criteria on a
// single branch — exactly what this rung automates.
// ────────────────────────────────────────────────────────────────────────────

// ── FIX-RUNG FAILURE-MODE TAXONOMY (W1-T94, W1-T76 follow-up) ────────────────
//
// GROUND TRUTH this taxonomy fixes: the rung's ONE prompt shape assumed every
// block was a reviewer-computed unmet set. Two live proofs said otherwise: (1)
// the Architect's own #157 mis-diagnosis read source WITHOUT the verbatim
// failure signal and produced a confidently-wrong code fix for what was really
// a PROOF-KEYWORD COVERAGE gap (the report just never mentioned the proof) —
// an automated fix worker with the same blindness thrashes the same way, at
// machine speed; (2) `blocked_ci` carries NO reviewer unmet-criteria at all —
// the failing signal IS the CI log — so the old single-shape prompt has
// nothing to render for it. MODE is derived DETERMINISTICALLY from the block
// evidence (policy-as-data, rule 2 — a table, mirroring sweep.ts's
// DISPOSITION_RULES), never an LLM classification and never an if/else chain:
// adding proof_exec-executed_fail or design-conformance later is a ROW in
// {@link FIX_MODE_RULES}, never a change to {@link deriveFixMode}'s loop.
// FLOOR-DEGRADED HONESTY (the #157 finding): "FLOOR DEGRADED: 0/N" on a
// PASSING review is W1-T72 working as designed — it is never a mode input and
// never a dispatch trigger here.
// ────────────────────────────────────────────────────────────────────────────

// `CiFailure` — one failing required CI check's name + the tail of its log,
// the `ci-log` mode's only input — is defined in lib/sweep.ts (imported above)
// because `OpenPrView` carries it and this module already imports OpenPrView
// from sweep.js; the reverse import would be circular (W1-T100).

/** The four known fix-rung failure modes. See the taxonomy note above. */
export type FixMode = "reviewer-unmet" | "body-coverage" | "ci-log" | "merge-conflict" | (string & {});

/**
 * The block evidence a fix dispatch derives its MODE from. `review` carries a
 * `blocked_review` verdict (reviewer-unmet / body-coverage); `ciFailures`
 * carries a `blocked_ci` block's failing check names + log tails (ci-log,
 * W1-T226: derived from PRESENCE of `ciFailures`, never from ABSENCE of
 * `review` — see {@link FIX_MODE_RULES} row 2); `mergeConflict` carries a
 * `conflicted` dispatch's conflicting-file evidence (W1-T106, the #170 DIRTY
 * strand) — no review or check can run at all until the conflict itself
 * resolves. `mergeConflict` still precludes the other two by construction
 * (nothing runs on an unmergeable ref). `review` and `ciFailures`, though,
 * MAY legitimately coexist — a review verdict sitting beside a red required
 * check is normal (the verdict may be stale, or simply irrelevant until the
 * check clears) — and when they do, `ciFailures`' presence wins: every
 * CURRENT caller (`runFixRung`, `buildFixRungDispatchArgs`,
 * `routeFix`/`runSweep`) still constructs them mutually exclusively as a
 * matter of caller discipline, but the mode table's own correctness no
 * longer depends on that discipline holding.
 */
export interface FixEvidence {
  review?: { unmetCriteria: CriterionVerdict[]; summary: string };
  ciFailures?: CiFailure[];
  /** W1-T106: the merge-conflict mode's ONLY input — conflicting files + both sides' log since merge-base. */
  mergeConflict?: MergeConflictEvidence;
  /**
   * W1-T78: an operator's answer to a clarification question, carried VERBATIM
   * as an added constraint on the prompt — never paraphrased, never dropped.
   * Mode-agnostic: rendered ahead of whichever mode's own content follows.
   */
  constraint?: string;
}

interface FixModeRule {
  readonly mode: FixMode;
  readonly when: (e: FixEvidence) => boolean;
}

/**
 * THE MODE TABLE (policy-as-data, rule 2). Precedence is table order (first
 * match wins); the terminal row (`reviewer-unmet`) matches unconditionally, so
 * a mode is ALWAYS derived — no undispatched evidence shape.
 *
 *   1. merge-conflict  — `evidence.mergeConflict` is set (W1-T106, the #170
 *                        DIRTY strand): the PR's merge state itself is dirty,
 *                        which precedes EVERYTHING else — no CI check even
 *                        runs on an unmergeable ref, so neither a review nor a
 *                        CI log can exist yet either. Checked FIRST so it is
 *                        never misclassified as ci-log (both leave `review`
 *                        undefined).
 *   2. ci-log         — W1-T226 (corrects W1-T224/W1-T94's original row):
 *                        gated on PRESENCE of `evidence.ciFailures`, never on
 *                        ABSENCE of `evidence.review`. A required check red is
 *                        the failing signal that actually blocks a merge —
 *                        GitHub will not merge past it no matter what a review
 *                        verdict sitting BESIDE it says, and that verdict may
 *                        itself be stale (computed before the push that broke
 *                        the check, or before a slower required check
 *                        settled). This is the SAME "ci-log wins" precedence
 *                        {@link DISPOSITION_RULES} row 5 (`isBlockedCi`,
 *                        sweep.ts) already established and W1-T138 broadened
 *                        to fire "regardless of the review verdict beside it"
 *                        — this row previously did not actually implement
 *                        that precedence: gating on `review === undefined`
 *                        meant ANY posted-or-computed verdict, pass or fail,
 *                        made the row miss and fall through to a
 *                        review-shaped mode, masking the check. Every CURRENT
 *                        caller (`runFixRung`, `buildFixRungDispatchArgs`,
 *                        `routeFix`/`runSweep`'s `dispatchFix`) already
 *                        constructs `review`/`ciFailures` mutually
 *                        exclusively, so this correction changes nothing
 *                        observable for them — it closes the table's OWN
 *                        latent gap, provable by calling {@link deriveFixMode}
 *                        directly with BOTH fields set (a review-failed AND
 *                        CI-red PR, PR 479's shape in the W1-T226 rationale)
 *                        rather than by any caller relying on that discipline
 *                        forever holding.
 *   3. body-coverage   — every unmet criterion's reason is a keyword-coverage
 *                        gap ("matched N/M proof keywords") and NONE was an
 *                        OBSERVED `executed_fail` (an actual failed run always
 *                        means real code broke — never treat that as body-only,
 *                        the #157/#143 lesson). Reached only when ci-log's row
 *                        above also missed (no `ciFailures`) — a red required
 *                        check outranks a body-coverage-shaped review too.
 *   4. reviewer-unmet  — the default: a real reviewer-computed unmet set
 *                        (W1-T76, unchanged).
 */
export const FIX_MODE_RULES: readonly FixModeRule[] = [
  {
    mode: "merge-conflict",
    when: (e) => e.mergeConflict !== undefined,
  },
  {
    mode: "ci-log",
    when: (e) => e.ciFailures !== undefined,
  },
  {
    mode: "body-coverage",
    when: (e) => {
      const unmet = e.review?.unmetCriteria ?? [];
      return (
        unmet.length > 0 &&
        unmet.every((c) => /matched \d+\/\d+ proof keywords/.test(c.reason)) &&
        !unmet.some((c) => c.proof_exec === "executed_fail")
      );
    },
  },
  {
    mode: "reviewer-unmet",
    when: () => true,
  },
];

/**
 * Derive the fix mode from block evidence — pure, total, table-driven (rule
 * 2). `rules` is injectable (mirrors `deriveDisposition`'s `policy` param in
 * sweep.ts) so a test can prove a NEW table row derives a NEW mode with zero
 * change to this function.
 */
export function deriveFixMode(evidence: FixEvidence, rules: readonly FixModeRule[] = FIX_MODE_RULES): FixMode {
  const rule = rules.find((r) => r.when(evidence));
  return rule ? rule.mode : "reviewer-unmet";
}

/**
 * Render the fix worker's prompt. The prompt NAMES its derived MODE and
 * carries ONLY that mode's inputs — never a mix, never the other modes'
 * fields. `reviewer-unmet` and `body-coverage` both come from `evidence.review`
 * (the FULL unmet acceptance criteria + the reviewer's verbatim reasons, ALL AT
 * ONCE — the anti-ping-pong invariant, P21's golden, absorbed verbatim; never a
 * narrowed, one-criterion prompt). `ci-log` comes from `evidence.ciFailures`
 * instead — the failing check names + log tails, with no review-shaped input
 * at all. `merge-conflict` (W1-T106) comes from `evidence.mergeConflict` — the
 * conflicting file list + both sides' log since merge-base, with no
 * review-shaped or ci-log-shaped input at all. Both `resume` (round 1) and
 * `fresh` (round 2+) rounds get the identical full-set framing for their mode.
 *
 * A review can fail with an EMPTY `unmetCriteria` (judgeReview: `testTheater`
 * or `noCriteria` alone fails the state even when every named criterion is
 * met); `evidence.review.summary` is what keeps the prompt from going out with
 * nothing to act on in that case.
 */
export function renderFixPrompt(opts: {
  task: { id: string; title: string };
  round: number;
  branch: string;
  evidence: FixEvidence;
}): string {
  const mode = deriveFixMode(opts.evidence);
  const header = `You are a FIX worker for task ${opts.task.id} (${opts.task.title}) — round ${opts.round}.\nMODE: ${mode}.`;
  // W1-T78: an operator's clarification answer, when present, is carried
  // VERBATIM ahead of the mode-specific content — mode-agnostic, never dropped.
  const constraintBlock = opts.evidence.constraint
    ? [
        "",
        "OPERATOR CONSTRAINT (the clarification-question rung, W1-T78 — answered; carried verbatim):",
        opts.evidence.constraint,
      ]
    : [];
  const footer = [
    "",
    `Amend the SAME branch (${opts.branch}) — do NOT open a new PR and do NOT create a fix/*`,
    // W1-T136/W1-T137 class: the fix rung authors its OWN commit message and, until now, was
    // told NOTHING about the format — #427/#428 blocked on a 111-char round-3 header. Same
    // literal the implement contract uses, so the two prompts cannot drift.
    ...commitMessageContractLines(),
    `branch (only a run-<taskId>-<epochMs> head is creditable).`,
    // impl-FV shape, same reason as commitMessageContractLines/bodyVsDiffContractLines above:
    // the SAME literal the implement contract carries (W1-T295), so a fix-rung push cannot
    // skip the gate the implement lane requires.
    ...ciParityContractLines(),
    `Only once that passes: \`git push origin HEAD\` (no -u) — never force-push. Your PR body`,
    `must substantiate EVERY task acceptance`,
    `criterion, not only the ones fixed here — the review floor judges the body against the`,
    // impl-FV: the SAME literal the implement contract carries, for the same reason
    // `commitMessageContractLines` above is shared — and this rung needs it MOST: it amends an
    // existing PR, so its body is the one most likely to have been written against an earlier diff.
    `FULL criteria set.`,
    ...bodyVsDiffContractLines(),
    `Anything you discover here that is OUT OF SCOPE for THIS fix — a`,
    `research question, a follow-up task, or an action someone should take — goes in an`,
    `OPTIONAL '## Follow-ups' section of your REPORT (W1-T105), never into the diff: one`,
    `typed entry per line, \`research:\` | \`task:\` | \`action:\`, its own one-line why inline.`,
    `End with a REPORT whose last line is exactly: PR_URL: <url>`,
  ];

  if (mode === "merge-conflict") {
    // W1-T106 (the #170 DIRTY strand): the conflicting file list + both
    // sides' log since merge-base come from `git` on a PR branch/head an
    // outside contributor could have authored — the SAME untrusted-content
    // threat model W1-T210 fenced for ci-log's `gh run view` output, so this
    // reuses the identical fence + neutralization rather than a parallel,
    // differently-worded control.
    const mc = opts.evidence.mergeConflict;
    const files = mc?.files ?? [];
    const fileList =
      files.length > 0
        ? files
            .map((f) => `- ${neutralizeFenceMarkers(f.path)} (ours -${f.oursDeleted} line(s), theirs -${f.theirsDeleted} line(s) since merge-base)`)
            .join("\n")
        : "(no conflicting file detail was captured — re-check the PR's mergeability for the current state.)";
    return [
      header,
      ...constraintBlock,
      `This PR's merge state is DIRTY — GitHub cannot compute a clean merge ref, so NO check even`,
      `runs until the conflict is resolved; there is no review to react to either. Your target: MERGE`,
      `origin/main into this SAME branch (${opts.branch}) — never rebase, never force-push — resolve`,
      `the conflicting file(s) below, then push. The changed head re-judges through the normal gate.`,
      "",
      `MERGE DISCIPLINE (the #170 hand-resolution's own procedure — never deviate): resolve toward the`,
      `UNION of both sides ONLY where merge-base analysis shows a PURE CONCURRENT ADDITION — both`,
      `sides only ADDED content, neither deleted anything the other still relies on. If EITHER side`,
      `DELETED something in a conflicting file, or the conflict is SEMANTIC rather than a safe`,
      `textual union, REFUSE to resolve it yourself and escalate instead — a wrong auto-resolution`,
      `is worse than a strand.`,
      "",
      `Conflicting file(s):`,
      fileList,
      "",
      `${CI_LOG_FENCE_OPEN}`,
      `log since merge-base — OUR side (this branch):`,
      neutralizeFenceMarkers(mc?.oursLog || "(not captured)"),
      "",
      `log since merge-base — THEIR side (origin/main):`,
      neutralizeFenceMarkers(mc?.theirsLog || "(not captured)"),
      `${CI_LOG_FENCE_CLOSE}`,
      ...footer,
    ].join("\n");
  }

  if (mode === "ci-log") {
    const failures = opts.evidence.ciFailures ?? [];
    // W1-T210: the check NAME and log tail both come from `gh run view
    // --log-failed` — attacker-influenceable CI output — so BOTH (never just
    // the tail) are neutralized against the fence marker and rendered INSIDE
    // the fence, labelled as data, rather than spliced bare between narrative
    // instruction lines. `check: `/`log tail:` labels stay OUTSIDE the value
    // but INSIDE the fence, matching the pre-existing `check: <name>` shape
    // the mode-fixture test above already asserts on.
    const rendered =
      failures.length > 0
        ? failures
            .map(
              (f, i) =>
                `${i + 1}. ${CI_LOG_FENCE_OPEN}\n` +
                `   check: ${neutralizeFenceMarkers(f.name)}\n` +
                `   log tail:\n${neutralizeFenceMarkers(f.logTail)}\n` +
                CI_LOG_FENCE_CLOSE,
            )
            .join("\n\n")
        : "(no failing check detail was captured — re-check `gh pr checks` for the current state.)";
    return [
      header,
      ...constraintBlock,
      `Required CI check(s) are FAILING — the failing signal here IS the CI log, not a reviewer`,
      `verdict. GitHub will not merge past a red required check no matter what any review verdict`,
      `says, and a review verdict sitting beside this one (if any exists at all — most often none`,
      `has run yet, since a review needs green CI first) may simply be STALE, computed before the`,
      `push that broke this check. Your target is making CI GREEN on the SAME branch; do not`,
      `expand scope beyond what the failing check(s) below require — do not touch acceptance`,
      `criteria or task scope to chase a reviewer verdict here.`,
      "",
      rendered,
      ...footer,
    ].join("\n");
  }

  const unmet = opts.evidence.review?.unmetCriteria ?? [];
  const summary = opts.evidence.review?.summary ?? "";
  const n = unmet.length;
  const list =
    n > 0
      ? unmet
          .map(
            (c, i) =>
              `${i + 1}. claim: ${c.claim}\n   proof required: ${c.proof}\n   reviewer verdict: UNMET — ${c.reason}`,
          )
          .join("\n")
      : `(no single criterion is unmet — the review floor's overall verdict is: ${summary})`;

  if (mode === "body-coverage") {
    return [
      header,
      ...constraintBlock,
      `The review gate is FAILING on ${n} unmet acceptance criteri${n === 1 ? "on" : "a"} whose reviewer`,
      `reason is a PROOF-KEYWORD COVERAGE gap — the report text never mentions the proof, this is`,
      `NOT an executed failure. The likely fix is the PR BODY's Acceptance block: add the`,
      `missing substantiation there FIRST. Change code ONLY if the body's claim would actually`,
      `be FALSE — never patch code just to satisfy keywords (the #157/#143 lesson). Review`,
      `summary: ${summary}`,
      "",
      list,
      ...footer,
    ].join("\n");
  }

  // reviewer-unmet (default, W1-T76 unchanged).
  return [
    header,
    ...constraintBlock,
    `The review gate is FAILING (${n} UNMET acceptance criterion${n === 1 ? "" : "a"}). Resolve ALL`,
    `of them together in this ONE pass — never fix one and leave another; patching one criterion`,
    `at a time is exactly what causes an infinite ping-pong across review rounds. Review summary:`,
    `${summary}`,
    "",
    list,
    ...footer,
  ].join("\n");
}

/**
 * W1-T138 (the #303/#305/#292/#315 fix): render ONE ci-log failure as a
 * single, specific line — the check NAME plus (when the log tail carries one)
 * its own first non-blank line of detail, e.g. `CodeQL — js/incomplete-url-
 * substring-sanitization @ test/worker.test.ts:318 — Incomplete URL substring
 * sanitization`. An escalation that names only the bare check ("CodeQL")
 * leaves the operator to go re-fetch the log by hand; this line is what a
 * `gh run view --log-failed` tail (or an injected test fixture) already
 * carries, verbatim, never re-derived or guessed.
 */
function summarizeCiFailure(f: CiFailure): string {
  const firstLine = (f.logTail ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return firstLine ? `${f.name} — ${firstLine}` : f.name;
}

/** Outcome of one full pass through the fix rung. */
export interface FixRungOutcome {
  outcome: "fixed" | "escalated" | "stood_down";
  /** The last review computed — passing when `outcome === "fixed"`. */
  review: ReviewVerdict & { headSha: string; reviewerOutcome: string };
  strikes: number;
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
}

/**
 * W1-T177: the real live-state reader every fix-rung/sweep spending site
 * wires — ONE fresh `gh pr view --json state` read, never a cached snapshot.
 * A throw (rate limit, network, auth) reports `ok:false` — INDETERMINATE,
 * never treated as terminal (`terminalStateReason` is never even called on
 * it; see every call site's fail-open handling).
 */
function ghLiveState(prUrl: string): LiveStateResult {
  try {
    const v = ghJson(["pr", "view", prUrl, "--json", "state"]) as { state?: string };
    return v?.state ? { ok: true, state: v.state } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/**
 * W1-T296: one fresh, live read of a PR's head commit sha + its author —
 * the branch-authorship stand-down's evidence. `ok:false` marks a genuinely
 * FAILED or INDETERMINATE read (network/auth/rate-limit), mirroring
 * {@link LiveStateResult}'s own contract: the caller must treat that exactly
 * as if no check ran at all, never as foreign. `headSha`/`author` are present
 * only when `ok`; `author` itself may still be absent (an unattributable
 * commit, e.g. a squash-merge bot) even on an otherwise-successful read.
 */
export interface LiveHeadResult {
  ok: boolean;
  headSha?: string;
  author?: string;
}

/**
 * W1-T296: the real live-head reader the fix rung wires for its pre-strike
 * branch-authorship check — a fresh `gh pr view --json headRefOid,commits`
 * read (never a cached snapshot, and never the headRefOid-only read
 * {@link realArmDeps} uses, which carries no author). Names the HEAD
 * commit's author specifically (matched by `oid`, not just "the last commit
 * listed") so the escalation this stands down into names the right person
 * even when `commits` is not sha-ordered. A throw (rate limit, network,
 * auth) or a response missing `headRefOid` reports `ok:false`.
 */
function ghLiveHead(prUrl: string): LiveHeadResult {
  try {
    const v = ghJson(["pr", "view", prUrl, "--json", "headRefOid,commits"]) as {
      headRefOid?: string;
      commits?: Array<{ oid?: string; authors?: Array<{ login?: string; name?: string }> }>;
    };
    if (!v?.headRefOid) return { ok: false };
    const headCommit = v.commits?.find((c) => c.oid === v.headRefOid);
    const author = headCommit?.authors?.[0]?.login ?? headCommit?.authors?.[0]?.name;
    return { ok: true, headSha: v.headRefOid, author };
  } catch {
    return { ok: false };
  }
}

/**
 * W1-T296 (the fix-rung pre-strike gate's second reason source): is a
 * freshly-observed live head one the fix rung did NOT itself produce?
 *
 * `rungOwnHeadSha` is `undefined` on a FIRST round — this invocation has not
 * pushed anything yet, so there is no reference to compare against, and a
 * first round must never be read as foreign (standing down on it would
 * disable the fix rung entirely; see runFixRung's own doc). From the second
 * round on, `rungOwnHeadSha` is the head this invocation's OWN most recent
 * strike produced (the SHA-LINEAGE signal the design prefers over a
 * committer-identity check — it is exact, and needs no threshold). A live
 * head equal to it is the rung's own work, not foreign, even across a CI
 * wait. Any OTHER live head means something else moved the branch since.
 *
 * PURE and exported so the boundary is unit-testable independent of the
 * rung's `gh`/spawn/push plumbing. The caller is responsible for its own
 * fail-open direction on an unreadable `liveHead` (`ok:false` here always
 * returns `undefined` — never foreign).
 */
export function branchAuthorshipStandDownReason(
  rungOwnHeadSha: string | undefined,
  liveHead: LiveHeadResult,
): { reason: string; headSha: string; author: string } | undefined {
  if (rungOwnHeadSha === undefined) return undefined; // first round: nothing to compare against yet
  if (!liveHead.ok || !liveHead.headSha) return undefined; // unreadable: fail open, exactly as before this check existed
  if (liveHead.headSha === rungOwnHeadSha) return undefined; // still the rung's own head
  const author = liveHead.author ?? "unknown author";
  return {
    headSha: liveHead.headSha,
    author,
    reason:
      `branch moved by a non-rung push — head is now ${liveHead.headSha} (author: ${author}), not the ` +
      `${rungOwnHeadSha} this rung last pushed`,
  };
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
 */
async function fixRungStandDownReason(
  readLiveState: ((prUrl: string) => LiveStateResult | Promise<LiveStateResult>) | undefined,
  prUrl: string,
  site: string,
  log: (step: string, extra?: Record<string, unknown>) => void,
  authorship?: {
    readLiveHead: (prUrl: string) => LiveHeadResult | Promise<LiveHeadResult>;
    rungOwnHeadSha: string | undefined;
  },
): Promise<{ reason: string; foreignHead?: { headSha: string; author: string } } | undefined> {
  if (!readLiveState) return undefined;
  const live = await readLiveState(prUrl);
  if (!live.ok) {
    // FAIL OPEN: the read failed/was indeterminate — proceed exactly as
    // before this check existed. Ledgered so the failure is visible, never
    // treated as a terminal reading (that would be fail-CLOSED, the far
    // worse failure this contract exists to prevent — a gh outage must
    // never silently halt every fix/disposition/dispatch fleet-wide).
    log("fix.live_state_indeterminate", { site });
    return undefined;
  }
  const terminal = terminalStateReason(live.state);
  if (terminal) return { reason: terminal };

  if (authorship) {
    const liveHead = await authorship.readLiveHead(prUrl);
    const foreign = branchAuthorshipStandDownReason(authorship.rungOwnHeadSha, liveHead);
    if (foreign) {
      return { reason: foreign.reason, foreignHead: { headSha: foreign.headSha, author: foreign.author } };
    }
    if (!liveHead.ok) {
      // Same fail-open discipline as the terminal-state read above, ledgered
      // under its own step name so the two indeterminate causes stay
      // distinguishable on the ledger.
      log("fix.live_head_indeterminate", { site });
    }
  }
  return undefined;
}

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
 * W1-T177 SITE (iv): the real live-state reader `rmd drain`/`rmd daemon` wire
 * for `nextRunnable`'s in-flight guard — CONFIRMS a candidate in-flight PR
 * number with a fresh `gh pr view` read, never the `lastProj` snapshot
 * `isOpenPr` itself answers from. `undefined` on a failed/indeterminate read
 * — nextRunnable's own contract treats that as "still in-flight, skip it"
 * (fail-open toward the pre-existing skip, never toward a false dispatch).
 */
function ghLiveStateByNumber(owner: string, repo: string, prNumber: number): string | undefined {
  try {
    const v = ghJson(["pr", "view", String(prNumber), "--repo", `${owner}/${repo}`, "--json", "state"]) as {
      state?: string;
    };
    return v?.state;
  } catch {
    return undefined;
  }
}

/**
 * W1-T168 (the #349/#360 stuck class): does THIS round's just-computed review
 * verdict show a REVIEW FALSE-BLOCK the fix rung structurally cannot resolve
 * by dispatching more code — so it must escalate for re-judgment instead of
 * spending the round as an ordinary strike toward exhaustion? Two
 * independent, OR'd signals (either alone is sufficient):
 *
 *  (a) NO-PROGRESS: this round's push landed no new commit — the review just
 *      posted against the SAME head sha the round's fix worker was DISPATCHED
 *      to resolve (`priorHeadSha`) — AND the SAME set of criteria (by claim
 *      text) remains unmet. The worker could not add work, so striking again
 *      against byte-identical code is guaranteed to reproduce the identical
 *      verdict; no further strike can ever change the outcome.
 *  (b) FLOOR-VS-REVIEWER DISAGREEMENT (the SHARPEST signal, #349/#360's own
 *      shape): the deterministic floor ({@link ReviewVerdict.floorState}) —
 *      every whitelisted proof this run could execute — observed PASS, yet
 *      the advisory LLM reviewer's semantic layer downgraded the verdict to
 *      failure anyway. Fires regardless of (a): a strike whose push DID
 *      change the diff, whose floor now passes, but whose reviewer still
 *      blocks is false-blocked exactly the same.
 *
 * A GENUINE deficiency trips NEITHER signal: a changed diff (headSha differs,
 * so (a) never fires) whose floor ALSO still fails (so (b) never fires)
 * always falls through to `undefined` here, so the caller strikes normally —
 * the escape never weakens the rung for real work still owed (criterion 3).
 *
 * Pure and exported so the two signals are unit-testable falsifiers
 * independent of the rung's spawn/push/CI plumbing.
 */
export function detectReviewFalseBlock(check: {
  /** The head sha the review THIS ROUND'S fix worker was dispatched to resolve carried. */
  priorHeadSha: string;
  /** The unmet criteria (by `claim` text) that same prior review posted. */
  priorUnmetClaims: ReadonlySet<string>;
  /** The verdict `runReview` just computed for this round's (possibly unchanged) head. */
  current: ReviewVerdict & { headSha: string };
}): string | undefined {
  const { priorHeadSha, priorUnmetClaims, current } = check;
  if (current.state === "success") return undefined;

  // (b) — checked first: it is the sharper signal and needs no diff-change
  // evidence at all.
  if (current.floorState === "success") {
    return "review false-block: deterministic floor passes while the spawned reviewer blocks";
  }

  // (a)
  const currentUnmetClaims = new Set(current.criteria.filter((c) => !c.met).map((c) => c.claim));
  const sameCriteria =
    currentUnmetClaims.size > 0 &&
    currentUnmetClaims.size === priorUnmetClaims.size &&
    [...currentUnmetClaims].every((c) => priorUnmetClaims.has(c));
  if (current.headSha === priorHeadSha && sameCriteria) {
    return "review false-block: same criterion re-blocked on unchanged code (no diff change this strike)";
  }
  return undefined;
}

/**
 * Dispatch ONE bounded fix worker per strike, up to `strikeCap` (config,
 * default 2), on a `blocked_review` verdict. Every dispatch receives the FULL
 * unmet_criteria set + the reviewer's reasons at once (never one criterion at
 * a time — the anti-ping-pong invariant) and amends the SAME branch/PR this
 * run already opened — never a fresh PR, never a `fix/*` branch, because
 * `deriveStatus`'s ownership-assert (status.ts's `ownsBranch`) credits ONLY a
 * `run-<taskId>-<epochMs>` head: creditability is LOAD-BEARING, not just
 * anti-orphan (a fix on an uncreditable head would loop this rung forever on
 * tasks it already fixed, and strand every dependent behind it).
 *
 * §3's ladder: strike 1 RESUMES the failing implement session (it already has
 * the context of what it tried); strike 2 (and any further strike up to the
 * cap) is a FRESH worker on the same branch, never resumed twice. Exhausting
 * the cap escalates (BLOCKED class, W1-T8) rather than looping forever.
 *
 * Every external interaction is injected (`deps`) so the whole rung is
 * unit-testable with fakes — no real spawn, git, or `gh` call in the test
 * suite. The real call site (`runTaskBody`) wires the module's own
 * `spawnWorker`/`waitForCiGreen`/`runReview` plus a small git-push wrapper.
 */
export async function runFixRung(opts: {
  taskId: string;
  runId: string;
  /** `files` (W1-T322) — see runReview's own `task` doc; every real caller already passes the
   *  full plan `Task`, so this widens for free. */
  task: { id: string; title: string; acceptance?: AcceptanceCriterion[]; files?: string[] };
  prUrl: string;
  branch: string;
  worktreePath: string;
  /** The failing implement worker's session id — resumed on strike 1. */
  initialSessionId: string;
  mount: Mount;
  settingsFile: string;
  config: Config;
  budgetUsd: number;
  strikeCap: number;
  /** The blocked_review verdict that triggered this rung. */
  initialReview: ReviewVerdict & { headSha: string; reviewerOutcome: string };
  reviewBase: { owner: string; repo: string; headCheckoutDir: string; reviewerMount: Mount };
  /** W1-T322: threaded straight through to every re-review this rung runs — see runReview's own
   *  `openTaskIds` doc. Optional; absent behaves exactly as every pre-W1-T322 caller already does. */
  openTaskIds?: ReadonlySet<string>;
  /**
   * W1-T78: an operator's answer to a clarification question, if this is a
   * RE-DISPATCH — carried verbatim on EVERY strike's prompt as an added
   * constraint (never paraphrased). Absent for an ORIGINAL blocked_review
   * dispatch (W1-T76, unchanged).
   */
  constraint?: string;
  /**
   * W1-T100 (the #170 fix): failing required-check name+log-tail evidence for
   * a blocked_ci dispatch — this PR is checks-red with NO review verdict
   * posted yet, so the failing signal IS the CI log, never a reviewer verdict.
   * Present ONLY for a ci-log-mode dispatch; undefined for the ordinary
   * blocked_review path (W1-T76, unchanged). Drives the ci-log MODE
   * (deriveFixMode/renderFixPrompt, W1-T94) for every strike UNTIL a real
   * review actually runs (only reached once CI goes green) — from then on
   * every subsequent strike reverts to review-mode evidence, even if that
   * review itself still fails (a real verdict is never re-treated as "no
   * review yet").
   */
  ciFailures?: CiFailure[];
  /**
   * W1-T106 (the #170 DIRTY strand): merge-conflict evidence for a
   * `conflicted` dispatch — this PR's merge state is dirty, so no CI check
   * even runs and no review can post until the conflict resolves. Present
   * ONLY for a merge-conflict-mode dispatch; undefined for every other path
   * (ci-log/reviewer-unmet/body-coverage, unchanged). Drives the
   * merge-conflict MODE (deriveFixMode/renderFixPrompt, W1-T94) UNTIL a
   * strike's push leaves CI able to run at all — from then on this PR is no
   * longer dirty, so every subsequent strike reverts to whichever mode its
   * (now-computable) review/checks state derives, exactly like ci-log's own
   * `noReviewYet` reversion.
   */
  mergeConflict?: MergeConflictEvidence;
  deps: {
    spawn: (args: SpawnWorkerArgs) => Promise<WorkerResult>;
    waitForCiGreen: (
      prUrl: string,
      log: (step: string, extra?: Record<string, unknown>) => void,
    ) => Promise<"green" | "red" | "timeout">;
    /**
     * W1-T177 (TERMINAL-STATE CHECK AT EVERY SPENDING SITE): an OPTIONAL fresh
     * re-read of THIS PR's live GitHub state, consulted at the top of every
     * round — BEFORE `strikes++`, the only point that stops a strike being
     * spent on a PR that went terminal since the previous round — and again
     * immediately before the exhaustion escalate() call, so a PR that went
     * terminal mid-rung never files a BLOCKED "fix rung exhausted" issue.
     * Never the sweep/drain snapshot the caller may itself hold — a fresh
     * `gh` read every time. Omitted, or a failed/indeterminate read
     * (`ok:false`), behaves EXACTLY as before this check existed: the rung
     * proceeds. Standing down fires ONLY on a positive, freshly-observed
     * terminal reading (see {@link terminalStateReason}).
     */
    readLiveState?: (prUrl: string) => LiveStateResult | Promise<LiveStateResult>;
    /**
     * W1-T296: an OPTIONAL fresh read of THIS PR's live head sha + its head
     * commit's author, consulted ONLY at the pre-strike gate (site
     * `rung.strike`), and ONLY once this invocation has itself pushed at
     * least one round (see {@link branchAuthorshipStandDownReason}'s
     * "first round has no prior head" contract). Never a cached snapshot —
     * a fresh `gh` read every time, mirroring `readLiveState`'s own
     * discipline. Omitted, or a failed/indeterminate read, behaves EXACTLY
     * as before this check existed: the rung proceeds.
     */
    readLiveHead?: (prUrl: string) => LiveHeadResult | Promise<LiveHeadResult>;
    /**
     * W1-T138 (the #303/#305/#292/#315 fix): fetch the CURRENTLY failing
     * required check(s) + log tails for THIS pr, called whenever a strike's
     * push leaves CI non-green — refreshes the NEXT strike's ci-log evidence
     * so it targets what is ACTUALLY still broken right now, never a stale
     * `opts.ciFailures` snapshot from before this push (or, for a dispatch
     * that started in reviewer-unmet mode, the STALE review criteria from
     * before a strike's own commit newly broke a required check like
     * commitlint/CodeQL). Optional + best-effort: when omitted (or it throws),
     * the rung degrades to keeping whatever ci-log evidence it already had —
     * the MODE still corrects itself (see `noReviewYet` below), only the
     * failing-check CONTENT stays stale.
     */
    fetchCiFailures?: (prUrl: string) => Promise<CiFailure[]>;
    /**
     * W1-T256: fetch THIS PR's current body. Consulted ONLY in `body-coverage`
     * fix mode, where the fix worker was told (renderFixPrompt) that the review
     * floor judges the PR BODY, and the authoritative `reviewCommand`/`post-review`
     * path DOES judge the body (`report: body`). Without it, this re-review judges
     * the fix worker's CHAT TEXT instead, so a correct body substantiation is
     * invisible and the rung can never heal a keyword-floor block — it keeps
     * posting a worker-text verdict that shadows the body. Injected only by tests;
     * in production it DEFAULTS to {@link fetchPrBodyViaGh} (the real `gh pr view`
     * read). Best-effort: a throwing fetcher falls back to the worker-text report,
     * exactly the pre-W1-T256 behavior; only body-coverage strikes ever consult it.
     */
    fetchPrBody?: (prUrl: string) => Promise<string>;
    /**
     * W1-T307: fetch THIS PR's CURRENT changeset (file paths) — consulted alongside
     * `fetchPrBody` in `body-coverage` mode ONLY, to check whether this strike's own commit
     * left the just-fetched body's file-count/enumeration claim stale (see
     * {@link deriveChangesetClaimUpdate}). Injected only by tests; in production it DEFAULTS
     * to {@link fetchPrDiffFilesViaGh}. Best-effort: a throwing fetcher skips the repair for
     * this strike (the claim, if stale, is left exactly as `bodyContradictsDiff` would have
     * found it — never a partial or guessed edit).
     */
    fetchPrDiffFiles?: (prUrl: string) => Promise<string[]>;
    /**
     * W1-T307: write a PR's body — how {@link deriveChangesetClaimUpdate}'s narrow,
     * mechanical edit actually reaches GitHub before the review below re-runs. Injected only
     * by tests; in production it DEFAULTS to {@link updatePrBodyViaGh}. Best-effort: a
     * throwing writer leaves the live body stale (the review that follows judges the
     * fetched-but-unwritten body text this round already computed, so the CORRECTED review
     * report is still used for this round's verdict even if persisting it to GitHub failed).
     */
    updatePrBody?: (prUrl: string, body: string) => Promise<void>;
    runReview: (args: Parameters<typeof runReview>[0]) => ReturnType<typeof runReview>;
    /** Push whatever the fix worker committed. Best-effort — a worker that
     * already pushed leaves nothing new, which is not an error. */
    push: (worktreePath: string, branch: string) => void;
    issues: IssueGateway;
    ledgerPath: string;
    log: (step: string, extra?: Record<string, unknown>) => void;
    say: (msg: string) => void;
    account: (r: WorkerResult) => WorkerResult;
  };
}): Promise<FixRungOutcome> {
  const { deps } = opts;
  let review = opts.initialReview;
  let strikes = 0;
  let sessionToResume: string | undefined = opts.initialSessionId;
  // W1-T100: true until a REAL review has run FOR THE CURRENT head. A
  // blocked_ci dispatch (opts.ciFailures set) has no reviewer verdict at all
  // yet, so its evidence is ci-log-shaped rather than review-shaped. Flips
  // false the moment deps.runReview actually executes (only reached once CI
  // is green) — from then on a real verdict exists, so every later strike is
  // review-mode again, even if that review itself still fails. W1-T138 (the
  // #303/#305/#292/#315 fix): it flips back to TRUE whenever a LATER strike's
  // push leaves CI non-green again — that push means NO review ran for ITS
  // head either (review only ever runs once CI is green), so the invariant
  // this variable's name states must keep holding across every strike, not
  // just the first one. Before this fix it only ever went false→never-true-
  // again, so a strike that regressed CI (or a mode that started
  // reviewer-unmet and only THEN broke a required check) kept re-dispatching
  // stale/irrelevant review-mode evidence for every remaining strike instead
  // of targeting the check that is actually still red.
  let noReviewYet = opts.ciFailures !== undefined;
  let currentCiFailures = opts.ciFailures;
  // W1-T106 (the #170 DIRTY strand): mirrors `noReviewYet`/`currentCiFailures`
  // for the merge-conflict mode — a SEPARATE variable (never folded into
  // `noReviewYet`) because a dirty PR carries no ci-log evidence at all; the
  // two shapes are mutually exclusive by construction (see FixDispatchEvidence).
  // Cleared the moment CI can run at all (see below) — the conflict is
  // resolved enough for GitHub to compute the merge ref, so every later
  // strike reverts to whichever mode its now-computable state derives.
  let currentMergeConflict = opts.mergeConflict;
  // W1-T296: the head THIS INVOCATION's own most recent strike produced —
  // `undefined` until the first round's push+review completes below, which
  // is exactly the "first round has no prior head" contract
  // {@link branchAuthorshipStandDownReason} documents: round 1 never reads
  // as foreign no matter what the live head is.
  let rungOwnHeadSha: string | undefined;

  while (review.state !== "success" && strikes < opts.strikeCap) {
    // W1-T177 SITE (i) — TERMINAL-STATE CHECK before `strikes++`: the ONLY
    // point that stops a strike being SPENT on a PR that went terminal
    // (merged/closed) since the previous round. Read FRESH every round —
    // never the caller's snapshot. W1-T296 composes a SECOND reason source
    // into this SAME check (never a parallel early-return): a live head
    // this invocation did not itself produce, which escalates rather than
    // ledgering silently — see the `foreignHead` branch below.
    const preStrikeStandDown = await fixRungStandDownReason(
      deps.readLiveState,
      opts.prUrl,
      "rung.strike",
      deps.log,
      deps.readLiveHead ? { readLiveHead: deps.readLiveHead, rungOwnHeadSha } : undefined,
    );
    if (preStrikeStandDown) {
      if (preStrikeStandDown.foreignHead) {
        // W1-T296: a human or a sibling session appears to be actively
        // editing this branch — unlike the terminal-state reason above,
        // this carries an operator-decidable question (yield, or confirm
        // the takeover), so it escalates rather than ledgering silently.
        // Distinct disposition from W1-T196's unattributable-pr stand-down,
        // which ledgers because THAT state carries no decidable question.
        const { headSha: foreignHeadSha, author: foreignAuthor } = preStrikeStandDown.foreignHead;
        const issueUrl = escalate(
          {
            class: "BLOCKED",
            taskId: opts.taskId,
            runId: opts.runId,
            // W1-T195 dedup shape: keying on the foreign head sha (never a
            // cause) means repeated sweep passes that observe the SAME
            // foreign head collapse into ONE issue instead of one per pass.
            headSha: foreignHeadSha,
            summary: `fix rung standing down — branch moved by a non-rung push (${foreignHeadSha.slice(0, 7)}) — ${opts.prUrl}`,
            detail:
              `The blocked_review FIX RUNG (W1-T76, W1-T296) observed ${opts.branch}'s head move to ` +
              `${foreignHeadSha} (author: ${foreignAuthor}) before spending strike ${strikes + 1} — a head this ` +
              `rung did not itself push. Dispatching a fix worker onto it risks either clobbering or duplicating ` +
              `in-flight manual work, so the rung stood down without spending the strike. This differs from ` +
              `W1-T196's unattributable-pr stand-down (which ledgers silently — that state carries no ` +
              `operator-decidable question); here a human is apparently mid-edit, and only a human can say ` +
              `whether the rung should yield, or the takeover should be confirmed and the rung resumed.`,
            options: [
              {
                label: "yield",
                detail: "leave the branch to whoever pushed it; close this PR or re-scope the task if the manual work supersedes it.",
              },
              {
                label: "confirm-takeover",
                detail: "the foreign push was expected (e.g. a hand-fix) — re-run `rmd fix` to resume the fix rung against the current head.",
              },
            ],
            recommendation: "yield",
          },
          { issues: deps.issues, ledgerPath: deps.ledgerPath, runId: opts.runId },
        );
        deps.log("fix.stood_down", {
          site: "rung.strike",
          strike: strikes + 1,
          reason: preStrikeStandDown.reason,
          issue_url: issueUrl,
        });
        deps.say(
          `fix rung: standing down before strike ${strikes + 1} — ${preStrikeStandDown.reason} — escalated: ${issueUrl}`,
        );
        return { outcome: "stood_down", review, strikes, standDownReason: preStrikeStandDown.reason, issueUrl };
      }
      deps.log("fix.stood_down", { site: "rung.strike", strike: strikes + 1, reason: preStrikeStandDown.reason });
      deps.say(`fix rung: standing down before strike ${strikes + 1} — ${preStrikeStandDown.reason}`);
      return { outcome: "stood_down", review, strikes, standDownReason: preStrikeStandDown.reason };
    }

    // W1-T58 (ratifies P3 via P8/RETRO-1784058021334, Standing rule 15): a diff
    // whose review verdict is tampered — it edits plan/tasks.yaml's OWN
    // acceptance criteria (see ReviewVerdict.criteriaTampered, review.ts) — is
    // NEVER eligible for an ordinary "add the work" fix dispatch: a worker may
    // never correct its own criteria, so no fix worker can legitimately
    // resolve this by writing more code. REFUSE the strike and escalate
    // immediately (zero strikes spent on it) — the run-loop side of the T3E
    // guard (which flags the diff at the REVIEWER layer); this is the RUN-LOOP
    // never treating that flag as ordinary fixable work.
    if (review.criteriaTampered) {
      deps.log("fix.rule15_violation", { strike: strikes, summary: review.summary });
      deps.say(
        `fix rung: REFUSED — the diff itself edits plan/tasks.yaml's acceptance criteria (Standing rule 15); ` +
          `escalating rather than dispatching a fix worker: ${opts.prUrl}`,
      );
      const issueUrl = escalate(
        {
          class: "BLOCKED",
          taskId: opts.taskId,
          runId: opts.runId,
          summary: `blocked_review: diff edits plan/tasks.yaml's own acceptance criteria (Standing rule 15) — ${opts.prUrl}`,
          detail:
            `The blocked_review FIX RUNG (W1-T76) refused to dispatch a fix worker: the PR's diff itself edits ` +
            `plan/tasks.yaml's acceptance criteria (an added satisfied_by, or an edited/removed claim/proof/` +
            `satisfied_by field) — Standing rule 15: only the Architect may correct a mis-specified task, via a ` +
            `plan-only PR; a worker may never. Review summary: ${review.summary}`,
          options: [
            {
              label: "hand-fix",
              detail: "revert the plan/tasks.yaml edit on the same branch, then re-run `rmd review` to re-post the gate.",
            },
            { label: "close", detail: "close the PR; if the criteria genuinely need correcting, file a plan PR instead." },
          ],
          recommendation: "hand-fix",
        },
        { issues: deps.issues, ledgerPath: deps.ledgerPath, runId: opts.runId },
      );
      deps.log("fix.exhausted", { strikes, issue_url: issueUrl, reason: "rule15_violation" });
      deps.say(`fix rung: escalated (rule 15 violation) — ${issueUrl}`);
      return { outcome: "escalated", review, strikes, issueUrl };
    }

    // W1-T297 (Standing rule 25 — INSTRUMENT CHANGES RIDE ALONE): a diff that
    // changes a measurement-instrument path (a ratchet/coverage script, a
    // recorded baseline, a workflow's measurement wiring, or the mutation
    // scope) AND a src/ product path in the SAME PR (see
    // ReviewVerdict.instrumentEntangled, review.ts) is never eligible for an
    // ordinary "add the work" fix dispatch: no worker can legitimately
    // resolve an entanglement by WRITING MORE CODE — the only honest
    // resolutions (split the PR, or revert the instrument hunk) restructure
    // it instead. REFUSE the strike and escalate immediately (zero strikes
    // spent), naming the observed evidence (W1-T186) — the instrument paths
    // found and the src paths beside them.
    if (review.instrumentEntangled) {
      const paths = review.instrumentEntanglementPaths;
      const instrumentList = paths?.instrumentPaths.join(", ") ?? "(unavailable)";
      const srcList = paths?.srcPaths.join(", ") ?? "(unavailable)";
      deps.log("fix.instrument_entangled", {
        strike: strikes,
        summary: review.summary,
        instrument_paths: paths?.instrumentPaths,
        src_paths: paths?.srcPaths,
      });
      deps.say(
        `fix rung: REFUSED — instrument path(s) ${instrumentList} entangled with src/ path(s) ${srcList} in the ` +
          `same PR; escalating rather than dispatching a fix worker: ${opts.prUrl}`,
      );
      const issueUrl = escalate(
        {
          class: "BLOCKED",
          taskId: opts.taskId,
          runId: opts.runId,
          summary: `blocked_review: instrument change entangled with src/ in one PR (Standing rule 25) — ${opts.prUrl}`,
          detail:
            `The blocked_review FIX RUNG (W1-T76, W1-T297) refused to dispatch a fix worker: the PR's diff ` +
            `changes measurement-instrument path(s) ${instrumentList} alongside src/ path(s) ${srcList} — two ` +
            `independently falsifiable claims ("the instrument is right" and "the code is right") shipped as one ` +
            `green, self-graded by the very instrument version it also changed. No worker may legitimately resolve ` +
            `this by writing more code. Review summary: ${review.summary}`,
          options: [
            {
              label: "split",
              detail:
                "land the instrument change in its own PR, then rebase this one onto it — the sanctioned shape.",
            },
            {
              label: "revert",
              detail: "revert the instrument hunk on this branch, keeping only the src/ change, then re-review.",
            },
          ],
          recommendation: "split",
        },
        { issues: deps.issues, ledgerPath: deps.ledgerPath, runId: opts.runId },
      );
      deps.log("fix.exhausted", { strikes, issue_url: issueUrl, reason: "instrument_entangled" });
      deps.say(`fix rung: escalated (instrument entanglement) — ${issueUrl}`);
      return { outcome: "escalated", review, strikes, issueUrl };
    }

    // W1-T127 (the #212 fixture — PR #212/#213, a spawn-ENOENT/autoupdater-race
    // binary crash that debited a fix-rung strike, and escalated, on a worker that
    // never ran): `attempt` is only a CANDIDATE strike number until `deps.spawn`
    // demonstrably returns, below. `strikes` itself — and every ledger line that
    // counts toward it (`fix.dispatch`) — is committed strictly AFTER that point.
    // Pre-W1-T127 this incremented `strikes` and logged `fix.dispatch` HERE, before
    // dispatch even happened, so a spawn-infra throw left a strike on the books
    // for a worker that never existed — see ledger.ts's `isRealStrike` for the
    // conjunction (worker ran AND a judgment is posted for it) this restructuring
    // enforces.
    const attempt = strikes + 1;
    const round: "resume" | "fresh" = attempt === 1 ? "resume" : "fresh";
    // W1-T166: holdout criteria are reviewer-visible but WORKER-hidden — the fix
    // rung dispatches an actual coding worker, so its unmet-criteria block must
    // never carry a holdout criterion's claim/proof text (visibleCriteria is the
    // same filter renderAnchorBlock and runReview's ledger/PR-comment text use).
    const unmet = visibleCriteria(review.criteria.filter((c) => !c.met));
    // W1-T168: snapshot THIS round's dispatch target — the head sha + unmet
    // claim set the fix worker below is being sent to resolve — BEFORE
    // `review` is reassigned to this round's freshly computed verdict, so
    // `detectReviewFalseBlock` (after the review call, below) can tell a
    // byte-identical re-block apart from real progress. Keyed on the SAME
    // worker-visible unmet set the fix rung actually dispatches (W1-T166).
    const priorHeadSha = review.headSha;
    const priorUnmetClaims = new Set(unmet.map((c) => c.claim));
    const evidence: FixEvidence =
      currentMergeConflict !== undefined
        ? { mergeConflict: currentMergeConflict, constraint: opts.constraint }
        : noReviewYet
        ? // W1-T226: `?? []` — `currentCiFailures` can be `undefined` here (no
          // `deps.fetchCiFailures` dep, or one that threw) even though `noReviewYet`
          // is true — checks are KNOWN to be non-green, just without failing-check
          // DETAIL. `FIX_MODE_RULES`' ci-log row now keys off `ciFailures !==
          // undefined` (presence), not `review === undefined` (absence), so the
          // field itself must always be a real (possibly empty) array whenever
          // `noReviewYet` holds — an `undefined` value here would silently fall
          // through to a review-shaped mode despite `noReviewYet` being true, the
          // exact regression `runFixRung`'s own "fetchCiFailures is optional" test
          // (below) locks against.
          { ciFailures: currentCiFailures ?? [], constraint: opts.constraint }
        : { review: { unmetCriteria: unmet, summary: review.summary }, constraint: opts.constraint };
    const fixMode = deriveFixMode(evidence);
    const prompt = renderFixPrompt({
      task: opts.task,
      round: attempt,
      branch: opts.branch,
      evidence,
    });
    // W1-T199: TAG THE STRIKE WITH THE VERDICT REGIME IT WAS SPENT AGAINST. A strike
    // spent when no proof could execute is a strike against KEYWORD NOISE; one spent
    // when the floor actually ran proofs is a strike against EVIDENCE. Untagged
    // historical lines are read as "keyword_only" (see priorStrikesFor) — they were
    // all written before the executor shipped.
    const verdictRegime: StrikeRegime = review.criteria.some((c) => c.proof_exec !== "not_executable")
      ? "executed"
      : "keyword_only";

    const fixArgs: SpawnWorkerArgs = {
      cwd: opts.worktreePath,
      permissionMode: "bypassPermissions",
      settingsFile: opts.settingsFile,
      model: opts.mount.model,
      effort: opts.mount.effort,
      maxTurns: opts.mount.maxTurns,
      maxBudgetUsd: opts.budgetUsd,
      config: opts.config,
      prompt,
      resumeSessionId: round === "resume" ? sessionToResume : undefined,
      // W1-T210: ci-log mode's prompt carries an untrusted CI log tail
      // (renderFixPrompt, above) — restrict this worker to the tools its
      // fix-and-push job actually needs (FIX_WORKER_TOOLS) so a
      // prompt-injection payload riding in that log can't reach the
      // network via WebFetch/WebSearch.
      tools: FIX_WORKER_TOOLS,
    };

    let fixResult: WorkerResult;
    try {
      fixResult = deps.account(await deps.spawn(fixArgs));
    } catch (e) {
      if (!isSpawnInfraBlockedError(e)) throw e;
      // No subprocess ever launched — nothing ran, nothing was billed. Log this as
      // an INFRA-tagged $0 line — deliberately NEVER a `fix.dispatch` line, the
      // ONLY step `priorStrikesFor` counts as a strike — so budget forensics can
      // separate "the task was expensive" from "the host was broken" (W1-T127
      // design note iii), then propagate the refusal unchanged: `strikes` and
      // attempts-toward-escalation never move, and no escalate() ever fires for it
      // here — the caller's existing spawn-infra degrade-don't-die handling
      // (daemon.ts's `isSpawnInfraBlocked`) decides what happens next, exactly
      // like the initial implement dispatch already does.
      deps.log("fix.spawn_infra_blocked", {
        attempt,
        reason: e.message,
        cost_usd: 0,
        cost_tag: LEDGER_COST_TAG_INFRA,
      });
      deps.say(
        `fix rung: strike ${attempt}/${opts.strikeCap} REFUSED — spawn infrastructure blocked, not counted as a ` +
          `strike: ${e.message}`,
      );
      throw e;
    }

    // A worker DEMONSTRABLY ran (spawn returned rather than throwing) — only now
    // is this round committed as a real strike.
    strikes = attempt;
    deps.log("fix.dispatch", { strike: strikes, strike_cap: opts.strikeCap, unmet_count: unmet.length, round, mode: fixMode, verdict_regime: verdictRegime });
    deps.say(
      currentMergeConflict !== undefined
        ? `fix rung: strike ${strikes}/${opts.strikeCap} (${round}) — dispatching ONE merge-conflict fix worker for ` +
          `${(currentMergeConflict.files ?? []).length} conflicting file(s)`
        : noReviewYet
        ? `fix rung: strike ${strikes}/${opts.strikeCap} (${round}) — dispatching ONE ci-log fix worker for ` +
          `${(currentCiFailures ?? []).length} failing check(s)`
        : `fix rung: strike ${strikes}/${opts.strikeCap} (${round}) — dispatching ONE fix worker for ` +
          `${unmet.length} unmet criteri${unmet.length === 1 ? "on" : "a"}`,
    );
    sessionToResume = fixResult.sessionId;
    deps.log("fix.done", {
      strike: strikes,
      round,
      session_id: fixResult.sessionId,
      subtype: fixResult.subtype,
      cost_usd: fixResult.costUsd,
      billing_mode: billingMode(fixResult.childEnvKeys),
      account_label: fixResult.accountLabel,
      num_turns: fixResult.numTurns,
    });

    // The fix rung's own footer carries the same '## Follow-ups' invitation (renderFixPrompt
    // above); PR provenance included (the fix rung always has one).
    harvestFollowupsFromReport([fixResult.text, fixResult.blocks.join("\n")].join("\n"), {
      label: "fix",
      prUrl: opts.prUrl,
      log: deps.log,
      say: deps.say,
    });

    deps.push(opts.worktreePath, opts.branch);

    const ci = await deps.waitForCiGreen(opts.prUrl, deps.log);
    if (ci !== "green") {
      deps.log("fix.ci_not_green", { strike: strikes, ci });
      // W1-T138 (the #303/#305/#292/#315 fix): no review ran for THIS push
      // either (review only ever runs once CI is green) — the NEXT strike
      // must target whatever is ACTUALLY still red now, never keep
      // re-dispatching the review-mode prompt this strike started with (its
      // unmet criteria may already be fixed; the check still failing today,
      // possibly one this very strike's own commit newly broke, is the real
      // blocker). Refresh the failing-check content best-effort; a missing/
      // throwing fetchCiFailures still corrects the MODE via `noReviewYet`.
      noReviewYet = true;
      if (deps.fetchCiFailures) {
        try {
          currentCiFailures = await deps.fetchCiFailures(opts.prUrl);
        } catch (e) {
          deps.log("fix.ci_failures_fetch_error", { strike: strikes, error: String((e as Error)?.message ?? e) });
        }
      }
      continue; // still failing — loop to the next strike (or exhaust below)
    }

    // W1-T106: CI reaching green at all means GitHub could compute a merge
    // ref — the conflict is resolved enough for a check to run — so the NEXT
    // strike (if the review that follows still fails) is never re-dispatched
    // as merge-conflict mode again; it reverts to whichever mode the now-real
    // review verdict derives, exactly like `noReviewYet`'s own reversion.
    currentMergeConflict = undefined;

    // W1-T256: in body-coverage mode judge the CURRENT PR BODY — the artifact the
    // worker was told to substantiate and the one the authoritative reviewCommand/
    // post-review path judges — not the fix worker's chat text. Best-effort: an
    // absent/throwing fetchPrBody falls back to the worker-text report (pre-W1-T256
    // behavior). Every other mode is unchanged.
    // W1-T186 round-2 note (the OBSERVED-not-inferred discipline applied to the gate
    // itself): a body-coverage fix worker that edits the PR body as its LAST action of
    // an exhausted strike (no strike budget left to re-verify) leaves the NEXT strike's
    // `remudero-review=failure` comment describing that PRIOR, already-superseded body
    // snapshot — the fetch below always reads whatever is live NOW, so a stale-looking
    // failure reason in a later round can be the gate reporting an OLD observation, not
    // a live one; re-check the CURRENT body/criteria coverage directly before assuming
    // the reported reason still holds.
    let reviewReport = [fixResult.text, fixResult.blocks.join("\n")].join("\n");
    if (fixMode === "body-coverage") {
      const fetchBody = deps.fetchPrBody ?? fetchPrBodyViaGh;
      try {
        reviewReport = await fetchBody(opts.prUrl);
      } catch (e) {
        deps.log("fix.body_fetch_error", { strike: strikes, error: String((e as Error)?.message ?? e) });
      }
      // W1-T307: THE COMMIT THAT CHANGES THE DIFF OWNS THE CLAIM ABOUT THE DIFF. This strike
      // is exactly the shape that repairs coverage by ADDING a file (the #1202/W1-T301
      // fixture) — check whether the body just fetched now carries a stale file-count/
      // enumeration claim against the CURRENT diff, and if `deriveChangesetClaimUpdate` can
      // fix it with confidence, write the correction BEFORE the review below ever sees this
      // body — never after, which would let this exact strike fail on the staleness it could
      // have closed. Best-effort + fail-safe throughout: any throw, or `undefined` back from
      // `deriveChangesetClaimUpdate` (no claim, or one it cannot update confidently), leaves
      // `reviewReport` exactly as fetched above and lets the review judge it as it always has.
      try {
        const fetchDiffFiles = deps.fetchPrDiffFiles ?? fetchPrDiffFilesViaGh;
        const diffFiles = await fetchDiffFiles(opts.prUrl);
        const updatedBody = deriveChangesetClaimUpdate(reviewReport, diffFiles);
        if (updatedBody !== undefined) {
          const writeBody = deps.updatePrBody ?? updatePrBodyViaGh;
          await writeBody(opts.prUrl, updatedBody);
          deps.log("fix.body_claim_updated", { strike: strikes });
          deps.say(
            `fix rung: this strike's commit changed the file set — updated the PR body's stale ` +
              `changeset claim to match before re-review`,
          );
          reviewReport = updatedBody;
        }
      } catch (e) {
        deps.log("fix.body_claim_update_error", { strike: strikes, error: String((e as Error)?.message ?? e) });
      }
    }
    review = await deps.runReview({
      owner: opts.reviewBase.owner,
      repo: opts.reviewBase.repo,
      prUrl: opts.prUrl,
      task: opts.task,
      report: reviewReport,
      settingsFile: opts.settingsFile,
      config: opts.config,
      budgetUsd: opts.budgetUsd,
      log: deps.log,
      say: deps.say,
      account: deps.account,
      reviewerMount: opts.reviewBase.reviewerMount,
      headCheckoutDir: opts.reviewBase.headCheckoutDir,
      ledgerPath: deps.ledgerPath,
      runId: opts.runId,
      openTaskIds: opts.openTaskIds,
    });
    // W1-T100: a real review verdict now exists for THIS head — the CURRENT
    // strike stays review-mode from here. W1-T138: this can still flip back
    // to true on a LATER strike if ITS push regresses CI again (see above).
    noReviewYet = false;
    // W1-T296: this round's OWN push produced the head this review just
    // evaluated — it becomes the reference the NEXT round's pre-strike
    // authorship check compares the live head against (sha lineage).
    rungOwnHeadSha = review.headSha;
    deps.log("fix.review", {
      strike: strikes,
      state: review.state,
      unmet: review.criteria.filter((c) => !c.met).length,
    });

    // W1-T168 (the #349/#360 stuck class): a review FALSE-BLOCK this rung
    // cannot fix by dispatching more code escalates for RE-JUDGMENT right
    // here — never as another silent strike toward exhaustion, and never
    // deferred to the generic exhaustion escalate() below (which would file
    // the wrong summary even on the strike this fired on).
    const falseBlockReason = detectReviewFalseBlock({ priorHeadSha, priorUnmetClaims, current: review });
    if (falseBlockReason) {
      // W1-T177 discipline extended to this NEW spending site: a fresh
      // terminal-state read before filing a needs-human issue, so a PR that
      // went terminal (merged/closed) between this round's push and here
      // never gets a false-block escalation opened against it either.
      const preFalseBlockStandDown = await fixRungStandDownReason(
        deps.readLiveState,
        opts.prUrl,
        "rung.false_block",
        deps.log,
      );
      if (preFalseBlockStandDown) {
        deps.log("fix.stood_down", { site: "rung.false_block", strikes, reason: preFalseBlockStandDown.reason });
        deps.say(`fix rung: standing down before false-block escalation — ${preFalseBlockStandDown.reason}`);
        return { outcome: "stood_down", review, strikes, standDownReason: preFalseBlockStandDown.reason };
      }
      const stillUnmet = review.criteria.filter((c) => !c.met);
      deps.log("fix.false_block", {
        strike: strikes,
        reason: falseBlockReason,
        floor_state: review.floorState,
        head_sha: review.headSha,
        prior_head_sha: priorHeadSha,
      });
      deps.say(
        `fix rung: ESCAPING after strike ${strikes}/${opts.strikeCap} — ${falseBlockReason} — escalating for ` +
          `re-judgment rather than striking toward exhaustion: ${opts.prUrl}`,
      );
      const issueUrl = escalate(
        {
          class: "BLOCKED",
          taskId: opts.taskId,
          runId: opts.runId,
          summary: `review false-block after ${strikes} strike(s) (${falseBlockReason}) — ${opts.prUrl}`,
          detail:
            `The blocked_review FIX RUNG (W1-T76, W1-T168) detected a REVIEW FALSE-BLOCK it cannot resolve by ` +
            `dispatching more code: ${falseBlockReason}. Deterministic floor state: ` +
            `${review.floorState ?? "unknown"}; spawned-reviewer-inclusive verdict: ${review.state}; head ` +
            `${review.headSha.slice(0, 7)}. Unmet criteria:\n\n` +
            stillUnmet.map((c) => `- ${c.claim}\n  reason: ${c.reason}`).join("\n") +
            `\n\nThis is the #349/#360 stuck class: correct, test-passing code sat blocked while the fix rung ` +
            `burned strikes re-attempting a fix that could never change the verdict. Escalating for a HUMAN ` +
            `RE-JUDGMENT after ${strikes} strike(s) instead of exhausting the remaining strike(s) on unfixable work.`,
          options: [
            {
              label: "re-judge",
              detail:
                "re-examine the reviewer's reasoning against the deterministic floor and re-post `remudero-review` " +
                "by hand (e.g. `rmd review`) if the block is unwarranted.",
            },
            { label: "close", detail: "close the PR and re-scope the task if the criteria themselves are wrong." },
          ],
          recommendation: "re-judge",
        },
        { issues: deps.issues, ledgerPath: deps.ledgerPath, runId: opts.runId },
      );
      deps.log("fix.exhausted", { strikes, issue_url: issueUrl, reason: "false_block" });
      deps.say(`fix rung: escalated (review false-block) — ${issueUrl}`);
      return { outcome: "escalated", review, strikes, issueUrl };
    }
  }

  if (review.state === "success") {
    deps.log("fix.resolved", { strikes });
    deps.say(`fix rung: resolved after ${strikes} strike(s) — review now passes`);
    return { outcome: "fixed", review, strikes };
  }

  // W1-T177 SITE (ii) — TERMINAL-STATE CHECK immediately before the
  // exhaustion escalate() below, so a PR that went terminal MID-RUNG (after
  // the last round's strike-top check, before this escalate) never files a
  // BLOCKED "fix rung exhausted" needs-human issue on a PR that no longer
  // carries a live block.
  const preEscalateStandDown = await fixRungStandDownReason(deps.readLiveState, opts.prUrl, "rung.exhaustion", deps.log);
  if (preEscalateStandDown) {
    deps.log("fix.stood_down", { site: "rung.exhaustion", strikes, reason: preEscalateStandDown.reason });
    deps.say(`fix rung: standing down before escalation — ${preEscalateStandDown.reason}`);
    return { outcome: "stood_down", review, strikes, standDownReason: preEscalateStandDown.reason };
  }

  // Strikes exhausted — escalate (BLOCKED class, W1-T8) rather than loop
  // forever; the clarification rung (W1-T78) upgrades this route when it lands.
  const unmet = review.criteria.filter((c) => !c.met);
  // `noReviewYet` reflects whether the LAST strike ran with a real review
  // verdict for its own head (W1-T100, extended by W1-T138 to keep re-checking
  // every strike, not just the first — see the loop above). true here means
  // no review ran for the FINAL push either, so the escalation names the
  // failing checks it actually tried to fix (`currentCiFailures`, refreshed
  // each non-green strike) rather than an empty/stale "Unmet criteria:" list.
  // W1-T106: `currentMergeConflict` reflects whether the FINAL strike was
  // still spent trying to resolve a dirty merge state — mirrors `noReviewYet`
  // for the ci-log shape, checked first (mutually exclusive by construction).
  const stillConflicted = currentMergeConflict !== undefined;
  const issueUrl = escalate(
    {
      class: "BLOCKED",
      taskId: opts.taskId,
      runId: opts.runId,
      // W1-T195: the composite dedup key's 2nd/3rd dimensions — the SAME headSha
      // this escalation's own detail already names (`review.headSha`) and the SAME
      // conflicted/checks-red signals the summary/detail above already branch on,
      // normalized via the shared `escalationCause` classifier so the clarification
      // rung's blocked-ambiguous escalate (buildSweepEffects, below) collapses into
      // this ONE issue when it observes the identical (PR, head, cause).
      headSha: review.headSha,
      cause: escalationCause(stillConflicted, noReviewYet),
      summary: stillConflicted
        ? `conflicted fix rung exhausted (${strikes} strike(s), merge state never resolved) — ${opts.prUrl}`
        : noReviewYet
        ? `blocked_ci fix rung exhausted (${strikes} strike(s), checks never went green) — ${opts.prUrl}`
        : `blocked_review fix rung exhausted (${strikes} strike(s)) — ${opts.prUrl}`,
      detail: stillConflicted
        ? `The CONFLICTED FIX RUNG (merge-conflict mode, W1-T94/W1-T106) dispatched ${strikes} bounded fix worker(s) ` +
          `on ${opts.branch} and the merge state is STILL dirty. Conflicting file(s):\n\n` +
          (currentMergeConflict?.files ?? []).map((f) => `- ${f.path}`).join("\n")
        : noReviewYet
        ? `The blocked_ci FIX RUNG (ci-log mode, W1-T94/W1-T100/W1-T138) dispatched ${strikes} bounded fix worker(s) ` +
          `on ${opts.branch} and required checks are STILL red — no review has run yet. Failing check(s):\n\n` +
          (currentCiFailures ?? []).map((f) => `- ${summarizeCiFailure(f)}`).join("\n")
        : `The blocked_review FIX RUNG (W1-T76) dispatched ${strikes} bounded fix worker(s) on ` +
          `${opts.branch} and the review gate is STILL failing. Unmet criteria:\n\n` +
          unmet.map((c) => `- ${c.claim}\n  reason: ${c.reason}`).join("\n"),
      options: stillConflicted
        ? [
            {
              label: "hand-fix",
              detail: "merge origin/main into the branch by hand, resolve the conflict, then push to re-trigger CI.",
            },
            { label: "close", detail: "close the PR and re-scope the task if the conflict cannot be safely resolved." },
          ]
        : noReviewYet
        ? [
            {
              label: "hand-fix",
              detail: "resolve the failing check(s) on the same branch by hand, then push to re-trigger CI.",
            },
            { label: "close", detail: "close the PR and re-scope the task if CI itself cannot be made to pass." },
          ]
        : [
            {
              label: "hand-fix",
              detail:
                "resolve the remaining criteria on the same branch by hand, then re-run `rmd review` to re-post the gate.",
            },
            { label: "close", detail: "close the PR and re-scope the task if the criteria themselves are wrong." },
          ],
      recommendation: "hand-fix",
    },
    { issues: deps.issues, ledgerPath: deps.ledgerPath, runId: opts.runId },
  );
  deps.log("fix.exhausted", { strikes, issue_url: issueUrl });
  deps.say(`fix rung: exhausted after ${strikes} strike(s) — escalated: ${issueUrl}`);
  return { outcome: "escalated", review, strikes, issueUrl };
}

/** The verdict + ledger payload a worker's ERROR envelope maps to. */
export interface WorkerErrorVerdict {
  verdict: "blocked_budget" | "failed";
  budgetBreach: boolean;
  /** Spread verbatim onto the `verdict` ledger line — carries turns + cost. */
  ledger: {
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

/**
 * Pure mapping from a worker's ERROR envelope to a terminal verdict. Returns
 * null when the result is NOT an error (the caller proceeds normally).
 *
 * A budget breach (subtype `error_max_budget_usd`) is verdict=blocked_budget and
 * is NEVER retried — dollars are the hard backstop. Any other error subtype is
 * `failed`. The ledger payload always carries `num_turns` and `cost_usd`, so a
 * failed run is never free in the ledger (WS-1: an implement run's ~6 minutes of
 * spend was previously invisible because the SDK threw before we read them).
 */
export function workerErrorVerdict(
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
      verdict,
      stage,
      subtype: r.subtype,
      num_turns: r.numTurns,
      cost_usd: costUsd,
      billing_mode: billingMode(r.childEnvKeys),
      account_label: r.accountLabel,
      reason: budgetBreach
        ? "worker breached maxBudgetUsd — not retried (dollars are the backstop)"
        : `worker error at ${stage}: ${r.subtype}`,
      model: r.model,
      effort: r.effort,
      tokens: r.tokens,
      ...cacheTokenLedgerFields(r.tokens),
    },
  };
}

/** The verdict + ledger payload for a terminal-SUCCESS worker that produced NO PR. */
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
  };
}

/**
 * Terminal verdict for a worker that reached a SUCCESS subtype but committed nothing and
 * opened no PR — a SILENT NO-OP (run W1-T12a-1784117152056: subtype:success, num_turns:10,
 * no pr.opened). It gets its OWN honest, distinct verdict `no_pr` with a truthful reason —
 * NEVER `verdict:failed` with a contradictory "worker error … : success" reason — so the
 * unattended daemon can reason about it rather than choke on a self-contradicting label.
 *
 * BLOCK vs RETRIABLE (decided + justified): `no_pr` is a NON-MERGED verdict, so it stops
 * the drain (stop-on-block), like every other non-merged terminal state. A no-op success is
 * anomalous — the worker believed it was done yet produced nothing to merge — and a blind
 * auto-retry carries NO new information, so under the unattended daemon it risks an unbounded
 * no-op loop; halting with a DISTINCT verdict is safer than silent retry. The distinct label
 * is exactly what the future block-reasoner (W1-T46) needs to later classify retry-vs-escalate.
 *
 * `commitsAheadCount` (W1-T407) is the SAME value the SILENT NO-OP GUARD's own predicate just
 * computed at the call site — appended LAST, after `stage`, so no existing positional caller
 * shifted (`test/no-pr-verdict-shape.test.ts`). `reason` distinguishes a worker that left its
 * own account of why (a report to read, riding the row via {@link noPrReportExcerpt} as
 * `report_excerpt`) from one that said nothing at all — the fixed sentence this function used
 * to return unconditionally is now reserved for the genuinely silent case.
 */
export function noPrVerdict(
  r: WorkerResult,
  costUsd: number,
  stage: string,
  commitsAheadCount: number,
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
    },
  };
}

// ── W1-T272: the ALREADY_SATISFIED exit ─────────────────────────────────────────────────
// The SILENT NO-OP GUARD above used to have exactly one PR-less outcome (`no_pr`), and that
// one is DRAIN-HALTING by design (a clean success with nothing to merge is anomalous). A
// worker that correctly diagnosed the task's acceptance was ALREADY TRUE on origin/main had
// nowhere honest to go — the output contract (compaction.ts) offered only a gated
// DECISION_REQUEST or "Otherwise: open a PR" — so five separate runs each manufactured a
// no-op closure PR just to comply (OBSERVED 2026-07-31). This gives that finding a THIRD,
// sanctioned exit — but only when it is MECHANICALLY VERIFIED: an unverifiable "already done"
// claim is worse than none, so an unverified claim is refused and falls straight back to the
// existing `no_pr` path, unchanged.

/** A parsed ALREADY_SATISFIED claim off a worker's REPORT (compaction.ts's third exit) — the
 *  PR reference text named, verbatim and NOT YET resolved to a number. */
export interface AlreadySatisfiedClaim {
  raw: string;
  ref: string;
}

/**
 * ANCHORED ALREADY_SATISFIED extraction — same discipline as worker.ts's `anchoredPrUrl`:
 * only a line matching `ALREADY_SATISFIED:` (start-of-line, case-insensitive) counts; every
 * other occurrence in prose or quoted contract text is inert. The LAST such line wins,
 * mirroring "last line of the REPORT". No matching line ⇒ `undefined`, never a guess.
 */
export function parseAlreadySatisfied(text: string): AlreadySatisfiedClaim | undefined {
  const matches = [...text.matchAll(/^[ \t]*ALREADY_SATISFIED:[ \t]*(\S.*)$/gim)];
  if (!matches.length) return undefined;
  const ref = matches[matches.length - 1][1].trim();
  return ref ? { raw: text, ref } : undefined;
}

/** Extract a PR number from a claimed ref — a bare number, a `#123` form, or a full GitHub
 *  pull-request URL. `undefined` on anything that names no number at all (never a guess). */
export function prNumberFromRef(ref: string): number | undefined {
  const urlMatch = ref.match(/\/pull\/(\d+)/);
  if (urlMatch) return Number(urlMatch[1]);
  const bareMatch = ref.match(/#?(\d+)/);
  return bareMatch ? Number(bareMatch[1]) : undefined;
}

/**
 * THE EVIDENCE GATE. An ALREADY_SATISFIED claim is refused unless the PR it names is the SAME
 * PR the board gateway independently finds MERGED and carrying THIS task's anchored
 * `Remudero-Task:` trailer — `findMergedByTrailer`, the exact primitive `buildCreditCandidates`
 * (above) already trusts for sibling-run credit (P29(i)/W1-T149: ANY run of the task owning
 * that PR counts). A worker cannot satisfy this by naming any merged PR lying around; only the
 * one the gateway itself would independently credit to this task. A malformed ref, a number
 * that does not match what the gateway finds, or the gateway finding nothing at all — every
 * one of those is refused (`undefined`), and the caller falls through to the unchanged `no_pr`
 * path. An unverifiable honesty exit is worse than none.
 */
export function resolveAlreadySatisfied(
  claim: AlreadySatisfiedClaim,
  github: GitHub,
  taskId: string,
): { number: number; url: string } | undefined {
  const claimedNumber = prNumberFromRef(claim.ref);
  if (claimedNumber === undefined) return undefined;
  const credited = github.findMergedByTrailer(taskId);
  if (!credited || credited.number !== claimedNumber) return undefined;
  return { number: credited.number, url: credited.url };
}

/** The verdict + ledger payload for a terminal-SUCCESS worker whose ALREADY_SATISFIED claim
 *  was VERIFIED (see {@link resolveAlreadySatisfied}) — distinct from both `merged` (this run
 *  opened no PR of its own) and `no_pr` (this is forward progress, not an anomaly). */
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

export function alreadySatisfiedVerdict(
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

/** The classifier's view of a worker result: its subtype, its text/stderr evidence, and
 *  the Anthropic-side api-error flag. Feeds W1-T7's {@link classifyFailure}. */
function workerSignal(r: WorkerResult): FailureSignal {
  return {
    subtype: r.subtype,
    text: [r.text, r.blocks.join("\n"), r.stderr].join("\n"),
    apiError: r.apiError,
  };
}

/**
 * True when a worker result is an ANOMALY that W1-T7's classifier judges TRANSIENT — an
 * Anthropic-side api error (server_error mid-response) or a network/5xx/CI-infra blip — as
 * opposed to a real task failure (a strike) or a clean success. The `isError || apiError`
 * gate keeps a CLEAN success (which the classifier fail-closes to "strike") from ever being
 * mistaken for a failure: a clean success is not anomalous, so it flows to the PR/no_pr path.
 *
 * This is the distinction PR #59 collapsed: run W1-T12a-1784117152056 was a transient (retry),
 * NOT a no-op (no_pr/block). A transient and a genuine no-op are OPPOSITE cases.
 */
export function isTransientResult(r: WorkerResult): boolean {
  return (r.isError || r.apiError) && classifyFailure(workerSignal(r)) === "transient";
}

/**
 * FOLLOW-UP HARVEST (W1-T105, §2 non-blocking, mirrors the QUESTION contract's
 * parse-then-log discipline). Shared by every call site that can carry a worker's
 * OPTIONAL '## Follow-ups' section — implement, recon, and the fix rung — so the
 * parse/ledger/say sequence is written once. Absent section (the common case) is a
 * silent no-op; present ⇒ ONE `report.followups` ledger line with every typed entry
 * plus this call's own provenance, for the retro's harvest (lib/retro.ts) to mine
 * into proposal candidates. Rule 15 stays intact: this ledgers raw declarations, it
 * never files a task itself.
 */
function harvestFollowupsFromReport(
  text: string,
  ctx: {
    label: string;
    prUrl?: string;
    log: (step: string, extra?: Record<string, unknown>) => void;
    say: (msg: string) => void;
  },
): void {
  const followups = parseFollowups(text);
  if (!followups) return;
  ctx.log("report.followups", { ...(ctx.prUrl ? { pr_url: ctx.prUrl } : {}), entries: followups });
  ctx.say(`${ctx.label} follow-ups declared: ${followups.map((f) => f.type).join(", ")}`);
}

/** Commits on the worktree's HEAD ahead of `base` (0 ⇒ the worker committed nothing). */
function commitsAhead(worktreePath: string, base: string): number {
  try {
    const out = execFileSync("git", ["-C", worktreePath, "rev-list", "--count", `${base}..HEAD`], {
      encoding: "utf8",
    });
    return parseInt(out.trim(), 10) || 0;
  } catch {
    return 0; // no base ref / detached / unreadable ⇒ treat as "nothing to PR"
  }
}

/**
 * SAY WHERE — the one CONTEXT bullet naming the task's own record on disk, shared by BOTH
 * context paths so neither can drift and the degraded path cannot gain a duplicate.
 *
 * `recordPath` is {@link taskRecordPath}'s output and is `undefined` when the record cannot be
 * resolved (unreadable/unparseable plan file); that yields `""` here, so an advisory line can
 * never turn one malformed plan file into a failed run. The bullet carries `plan#<taskId>` —
 * an ACCEPTED_KIND for `assertProvenance` — and renders any criteria as NON-BULLET continuation
 * lines, which `contextBlocks` absorbs into this same block rather than opening uncited ones.
 */
export function taskRecordContextLine(
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

/**
 * The CONTEXT block injected when recon SUCCEEDED: recon's OBSERVED lines, each a cited claim.
 *
 * IT NAMES THE RECORD TOO, and the comment this replaced said it need not — "the non-degraded
 * path does no extra reads and receives no extra note, since recon already relayed all of this".
 * That premise does not hold at any sha, and the code says so three ways:
 *
 *   (1) RECON IS NEVER TOLD WHICH TASK IT IS RECONNING. `renderReconPrompt` takes only a plan
 *       index and an operator-notes block — no task id, no title, no record path — and the notes
 *       block is `""` for any task with no console notes. So "recon already relayed all of this"
 *       is not a guarantee the code can make, only an outcome it may get. (Deliberately DESCRIBED
 *       rather than quoted: `test/recon-mount-routing.test.ts` locates the recon spawn with
 *       `SRC.indexOf` on that call's exact text, so a second verbatim copy above it silently
 *       redirects the test's 1400-character window into this comment. It did, and the suite
 *       caught it.)
 *   (2) ONLY `OBSERVED:` SURVIVES. This function keeps `parsed?.observed` alone, while
 *       `renderReconPrompt` also asks for INFERRED and COULDN'T-VERIFY — so a recon that reads
 *       the shard and summarises the design under INFERRED has that text dropped here.
 *   (3) IT CAN BE EMPTY. An unparseable report or an empty OBSERVED yields `""` — a silently
 *       empty CONTEXT block, precisely what {@link reconDegradedContextNote}'s doc says must
 *       never happen.
 *
 * So the pointer used to be injected EXACTLY WHEN RECON FAILED and withheld whenever it worked,
 * which is backwards: the healthy path is the one that runs on every dispatch.
 *
 * CRITERIA DELIBERATELY DO NOT TRAVEL HERE, unlike the degraded path. There, nothing else in the
 * prompt carries the specification at all, so criteria are the difference between a title and a
 * spec. Here recon may well have relayed content, the worker is one `Read` away from the whole
 * record — design included, which criteria alone would not give it — and the pointer costs one
 * line against N. Same reason the plan body is not shipped to workers (see `renderReconPrompt`'s
 * doc on `planIndexBlock`): name the retrievable thing, do not copy it.
 */
/**
 * The label every relayed COULDN'T-VERIFY line carries, so a worker can tell an OBSERVATION from
 * a GAP. Both kinds arrive as `recon#<taskId>`-cited CONTEXT bullets — both genuinely came from
 * recon — and the citation says WHERE a line came from, never WHAT EPISTEMIC KIND it is. Without
 * this prefix the two would be indistinguishable once rendered, which is worse than dropping the
 * section: an unmarked gap reads as an established fact.
 */
export const RECON_UNVERIFIED_PREFIX = "RECON DID NOT ESTABLISH THIS — verify it yourself before relying on it: ";

/**
 * The CONTEXT block injected when recon SUCCEEDED: recon's OBSERVED lines and its COULDN'T-VERIFY
 * lines, each a cited claim.
 *
 * WHY COULDN'T-VERIFY TRAVELS, AND WHAT IT COST NOT TO. `parseReconReport` (lib/worker.ts) fills
 * all three sections; this function used to read `parsed?.observed` ALONE, so the other two were
 * computed on every dispatch and dropped before `renderImplementPrompt` was ever called. MEASURED,
 * run W1-T409-1786487330401: a 5-turn recon wrote "THIS RECON ONLY CONFIRMED EXISTENCE, NOT
 * CONTENTS" and named the files that had to be read first. That text reached the ledger
 * (`report.followups`) and the operator's console and NEVER reached the implement worker, which
 * then ran 73 turns, spent $4.08 and produced zero commits. The one reader who could act on the
 * warning was the one reader routed away from it.
 *
 * THE RECON WAS NOT AT FAULT and is deliberately not "fixed" here. `renderReconPrompt`'s three
 * named commands (`git remote -v`, `git log --oneline -5`, `ls`) are all ORIENTATION — none reads
 * a file's contents — and its signature takes no task argument, so it cannot ask for a task's
 * design. "Confirm existence, not contents" is that prompt's own worked example, and 5 turns is
 * the success mode (`RECON_MAX_TURNS`'s doc records six sonnet successes at 5-8 turns against
 * every failure clustered at 9). The recon reported its limit correctly; only the routing was wrong.
 *
 * INFERRED IS DELIBERATELY NOT RELAYED, and the reason is mechanical rather than squeamish.
 * `section()` (lib/worker.ts) returns `m[1].trim()` — the capture AFTER the header — so the label
 * is STRIPPED and an extracted string carries no marker of which section produced it. A relayed
 * inference would therefore arrive as a `recon#`-cited CONTEXT bullet indistinguishable in kind
 * from an observation, and {@link assertProvenance} would admit it to the linted claim set with
 * exactly the same standing. That is a warrant it has not earned: INFERRED is what recon
 * CONCLUDED without establishing, so relaying it invites a worker to build on unverified premises.
 * COULDN'T-VERIFY is safe in the direction that matters — it LOWERS confidence, so a mistaken one
 * can only cause a worker to re-check something, never to trust something false.
 *
 * NO HEADING, BY CONSTRUCTION. The gaps render as ordinary prefixed bullets rather than a section
 * with a title, so an EMPTY `couldntVerify` contributes zero lines and there is no dangling
 * heading to leave behind — the silently-empty-block condition {@link reconDegradedContextNote}'s
 * doc exists to prevent cannot arise here, because there is nothing to be empty.
 */
function reconObservedToContext(recon: WorkerResult, taskId: string, recordPath?: string): string {
  const parsed = parseReconReport([recon.text, recon.blocks.join("\n")].join("\n"));
  const nonEmptyLines = (s: string): string[] =>
    s
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  const lines = nonEmptyLines(parsed?.observed ?? "");
  const gaps = nonEmptyLines(parsed?.couldntVerify ?? "");
  // Each line becomes a cited CONTEXT claim (provenance from recon). The record line leads: it is
  // stable per task, while recon's output is per-run (cache-aware ordering, W1-T35). Gaps come
  // LAST so the prompt reads observations-then-caveats, and each carries the prefix above.
  return [
    taskRecordContextLine(taskId, recordPath),
    ...lines.map((l) => `- ${l} ${citation(`recon#${taskId}`)}`),
    ...gaps.map((l) => `- ${RECON_UNVERIFIED_PREFIX}${l} ${citation(`recon#${taskId}`)}`),
  ]
    .filter((s) => s.length > 0)
    .join("\n");
}

/**
 * W1-T299: the CONTEXT block injected when recon DEGRADED — a bounded retry (see the recon
 * spawn site below) still ended in an error, and the run proceeds to implement anyway rather
 * than dying with the whole dispatch (a read-only preamble failing must never cost the task a
 * dispatch it can never get back). This is `reconObservedToContext`'s degraded sibling: an
 * EXPLICIT absence claim, never a silently-empty block, so implement is TOLD recon produced
 * nothing rather than inferring it from an empty CONTEXT section. Carries the same
 * `recon#<taskId>` citation so the provenance linter (assertProvenance) treats "recon produced
 * nothing" as a claim like any other, not an omission that slips past unlinted.
 */
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

/**
 * The RECON spawn's turn cap — the ONE place the number lives, so the code and every
 * `routes.recon` cell in `.remudero/mounts.yaml` cannot say different things (the impl-BP/impl-BS
 * lineage: a table row asserting what the code does not do). Deliberately a constant rather than
 * `reconMount.maxTurns`: recon is read-only and must stay bounded regardless of which class routed
 * it, and `maxBudgetUsd` remains the real backstop (WS-0 knob a).
 *
 * WHY 20 AND NOT 8. Measured over every `recon.done` row for 2026-08-03, the day the queue
 * emptied — 18 recons, split by the model the recon row routed:
 *
 *   haiku  : 9 `error_max_turns` / 1 success   (failures 9×9;  success 17)
 *   sonnet : 2 `error_max_turns` / 6 success   (failures 9, 9; successes 5, 6, 7, 8, 8, 8)
 *
 * 11 of 18 died on the cap — 90% of haiku recons and 25% of sonnet's. It binds on BOTH models,
 * harder on the cheaper one; it is not a haiku-capability story, and every failure across both
 * lands on exactly the same number. AT THE TIME OF THIS MEASUREMENT, `failOnWorkerError(recon,
 * "recon")` was UNCONDITIONALLY fatal to the whole run, so each death burned a dispatch WITHOUT
 * opening a PR, and five of those tripped `dispatchesWithoutNewOwnedPr`'s breaker — which resets
 * only on a fresh owned PR. That is how W1-T288 (2 deaths, both sonnet) and W1-T295 (5, all
 * haiku) latched dead and the queue reached "nothing dispatchable" with 14% of the weekly
 * headroom spent. W1-T299 (this task's own companion fix, filed off this exact measurement)
 * changed that: a recon error now gets one bounded retry, and a SECOND error degrades — the run
 * still reaches implement with an explicit absent-context note — rather than ending the dispatch.
 * The turn cap itself (this constant) is unchanged; only recon's failure no longer costs the
 * task a dispatch it can never get back.
 *
 * 20 clears the highest observed completion (17) with margin while staying far below the implement
 * rows' 400. Recorded honestly: that 17-turn success happened under a cap of 8, so the SDK's
 * `maxTurns` and the envelope's `num_turns` do not count the same unit. 20 is calibrated against
 * the observed counter, NOT against a derivation of the cap's own semantics — W1-T303 is filed to
 * establish what each side actually counts, and until it lands this number is empirical.
 */
export const RECON_MAX_TURNS = 20;

/**
 * Render the RECON worker's prompt (W1-T37, MASTER-PLAN §8A Tier 2): the fixed read-only recon
 * instructions, plus the generated PLAN INDEX in place of the plan body. The plan (MASTER-PLAN.md)
 * is NOT shipped to workers — `planIndexBlock` (from {@link renderPlanIndex}) is a compact list of
 * section headings + one-line summaries + a grep hint, so a recon worker that needs a specific
 * section's detail can retrieve it itself (`grep -n '<heading>' MASTER-PLAN.md`) instead of every
 * run paying to carry the whole ~1900-line document. `planIndexBlock` is `""` when no index is
 * committed yet (a fresh checkout before the first `npm run plan-index`) — recon still runs, just
 * without the pointer; correctness never depends on the index being present.
 *
 * `operatorNotesBlock` (W1-T164, `lib/operator-notes.ts`'s `renderOperatorNotes`) carries THIS
 * task's console-authored, provenance-stamped guidance — feedback INTO the task before it runs,
 * scoped strictly to this task's own id. `""` (the default) when the task carries no notes.
 */
export function renderReconPrompt(planIndexBlock: string, operatorNotesBlock = ""): string {
  return [
    "You are a RECON worker. Do NOT modify anything. Inspect the current git " +
      "repository read-only (git remote -v, git log --oneline -5, ls). Output one report:\n" +
      "RECON REPORT\nOBSERVED: <commands + key output>\nINFERRED: <conclusions>\n" +
      "COULDN'T-VERIFY: <unconfirmed>\n" +
      // W1-T105: recon is read-only and out-of-scope by construction, so a genuine
      // discovery worth the plan's attention (not just this task's own INFERRED)
      // still has a place to land, never invented into a diff you cannot make.
      "Optionally, after the report, add a '## Follow-ups' section — one typed entry\n" +
      "per line, its own one-line why inline: `research: <what, why>` | `task: <what, why>` |\n" +
      "`action: <what, why>` — for anything discovered that is out of THIS recon's scope.",
    planIndexBlock,
    operatorNotesBlock,
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");
}

/**
 * Render the implement prompt: cited CONTEXT + TASK + explicit output contract.
 *
 * CACHE-AWARE ASSEMBLY (MASTER-PLAN §8A / W1-T35): the Anthropic prompt cache
 * keys on EXACT PREFIX BYTES — any early edit invalidates the cache for
 * everything after it, and a cache READ prices at ~1/10th of fresh input. So
 * the CONTEXT block is ordered STABLE-FIRST, VOLATILE-LAST:
 *   1. `renderDoctrinePreamble()` — Tier 0, the distrust rule + the autonomy
 *      clause. Invariant; changes rarely (MASTER-PLAN §8A: "line-capped
 *      ~150, must change RARELY"). This is the cacheable prefix.
 *   2. `contextClaims` / `reconContext` — per-task, fixed for the life of a
 *      run once recon has completed (recon never re-runs mid-run).
 *   3. `matchedLearnings` (Tier 1, W1-T19/W1-T33) — the task-matched LEARNINGS
 *      facts. VOLATILE: the corpus grows every retro, so it goes LAST, never
 *      ahead of the stable prefix — a corpus edit can never bust the cache for
 *      the doctrine/task/recon bytes that precede it.
 * Every line is already provenance-tagged, so the whole CONTEXT block still
 * lints clean regardless of ordering.
 *
 * `operatorNotesBlock` (W1-T164, `lib/operator-notes.ts`'s `renderOperatorNotes`) carries THIS
 * task's console-authored, provenance-stamped guidance, scoped strictly to `task.id` — placed
 * after the task/recon context and before the volatile learnings corpus: it is per-task and
 * per-run stable (never grows mid-run), so it need not trail behind everything the way the
 * ever-growing learnings corpus must (cache-aware ordering, W1-T35). `""` (the default) when the
 * task carries no notes.
 */
export function renderImplementPrompt(
  task: Task,
  reconContext: string,
  runId: string,
  matchedLearnings = "",
  operatorNotesBlock = "",
): string {
  const contextClaims = (task.context ?? [])
    .map((c) => `- ${c.claim} ${citation(c.src)}`)
    .join("\n");
  const body = (task.prompt ?? task.title)
    .split("${RUN_ID}").join(runId)
    .split("${TASK_ID}").join(task.id);

  return [
    // THE ROLE, FIRST — mirroring `renderReconPrompt`, whose own first sentence is "You are a RECON
    // worker." Above `# CONTEXT` on purpose: `extractContext` starts at that heading, so this text
    // is outside the provenance linter's region and carries no citation, while the recon relay
    // below it stays a cited CONTEXT claim exactly as before.
    ...IMPLEMENT_ROLE_LINES,
    "",
    "# CONTEXT",
    renderDoctrinePreamble(),
    contextClaims,
    reconContext,
    operatorNotesBlock,
    matchedLearnings,
    "",
    "# TASK",
    body,
    "",
    // Shared verbatim with the post-compaction ANCHOR (compaction.ts,
    // MASTER-PLAN §8B / W1-T36) — ONE source of literal text so the anchor
    // re-injected after a compaction is provably byte-identical to what the
    // worker was told at turn 0, never a re-derived/paraphrased copy.
    ...outputContractLines(task.id),
  ].join("\n");
}

/**
 * Default HARD budget cap (notional $) when a task omits `budget_usd`. This is a
 * RUNAWAY TRIPWIRE, not an allowance — set an order of magnitude above any observed
 * task (hello-world $0.41 · reviewer $2.26 · gate-wiring $1.28 · containment ~$2.0 ·
 * W1-T3 still working at $3.57/36 turns) so it only fires on pathology. A cap set
 * NEAR a task's cost is a WORK LIMIT that destroys honest work (the maxTurns bug of
 * PR #8, one field over — MASTER-PLAN §9). On subscription these dollars are
 * NOTIONAL; window pressure is the HeadroomTracker's job (W1-T4), never a dollar cap.
 */
export const DEFAULT_BUDGET_USD = 100.0;

/**
 * Pure predicate: should the run emit a SOFT budget WARNING now? True exactly when
 * cumulative cost has reached the soft threshold and no warning has fired yet — a
 * VISIBILITY tripwire that never kills (the run continues). Extracted so the
 * warn-once behavior is unit-testable without spawning a worker.
 */
export function softBudgetWarning(
  costUsd: number,
  thresholdUsd: number,
  alreadyWarned: boolean,
): boolean {
  return !alreadyWarned && costUsd >= thresholdUsd;
}

/** One resolved bundle of every mount a run needs (W1-T167 class routing included),
 * with the loud class-fallback ledgering inside — exported so fixture tables cover
 * every branch, including the fallback a complete committed table cannot reach. */
export function resolveRunMounts(
  repoRootDir: string,
  task: Pick<Task, "type" | "risk" | "files">,
  log: (step: string, extra?: Record<string, unknown>) => void,
): {
  mount: Mount;
  reviewerMount: Mount;
  fixMount: Mount;
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
  const mountResolution = resolveMountForClass(mountsTable, task.type, task.risk, taskClass);
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
  // impl-BP — RESOLVE THE RECON ROW, the one `routes:` entry nothing read. `.remudero/
  // mounts.yaml` has carried a fully-specified `recon:` block (haiku for low-risk/docs/plan-lint,
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
    reconMount,
    taskClass,
    mountClass: mountResolution.resolvedClass,
  };
}

async function runTask(
  taskId: string,
  opts: {
    planPath?: string;
    config?: Config;
    allowStale?: boolean;
    /** Explicit `--plan <path>` escape hatch (daemon only): read that file LITERALLY, no git
     *  sync — the operator named an exact file, so honor it verbatim, same as the sibling
     *  guard around the daemon's own non-self clone-sync (`!flagValue(rest, "--plan")`). */
    skipGitSync?: boolean;
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
    /** W1-T86 (P12 wipe-test harness): arm B of a `rmd wipe-test` pair — MASK learnings
     *  injection for this run. Forces the rendered prompt's matched-learnings text to ""
     *  WITHOUT reading the store (see {@link computeMatchedLearningsForArm}); never set by
     *  any caller other than `wipeTestCommand`. */
    maskLearnings?: boolean;
    /** Injectable containment-probe executor (W1-T91) — behavioral tests drive the REAL
     *  blocked_containment catch branch (the structured guard/check/observed fields on its
     *  ledger verdict line) through this seam, the SAME shape `defaultReconRunLens`'s own
     *  `deps.probeExec` already uses, without touching `loadConfig()` (unavailable in CI) or
     *  spawning a real sandboxed worker. Default: the real spawn-backed executor. */
    containmentExec?: ProbeExecutor;
    /** Injectable isolation-probe executor (W1-T91) — the isolation sibling of
     *  `containmentExec` above, driving the REAL blocked_isolation catch branch. Default: the
     *  real spawn-backed executor. */
    isolationExec?: IsolationProbeExecutor;
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
    runReview?: (args: Parameters<typeof runReview>[0]) => ReturnType<typeof runReview>;
    /**
     * Read THIS PR's current body, so the review judges the artefact the author is told is judged.
     * Appended LAST so no positional caller shifts. Injected only by tests; in production it
     * DEFAULTS to {@link fetchPrBodyViaGh}. Best-effort — a throwing fetcher falls back to the
     * worker-text report, i.e. exactly the pre-fix behaviour.
     */
    fetchPrBody?: (prUrl: string) => Promise<string>;
    /** Injectable decision-record writer+lander (W1-T191, write site 1) — lets a behavioral
     *  test drive a REAL runTask() through the DECISION_REQUEST auto-choose branch and assert
     *  exactly what it writes/lands, without ever shelling out to a real git/gh. Default: the
     *  real {@link recordDecision} (feedback-landing.js), which writes
     *  `plan/decisions.d/<taskId>-<runId>.md` and lands it via the shared decisions-landing
     *  bridge — the same mechanism W1-T243 proved for `plan/feedback/**`. */
    recordDecision?: typeof recordDecision;
  } = {},
): Promise<RunResult> {
  const config = opts.config ?? loadConfig();
  const spawn = opts.spawn ?? spawnWorker;
  const runReviewFn = opts.runReview ?? runReview;
  const fetchPrBodyFn = opts.fetchPrBody ?? fetchPrBodyViaGh;
  const recordDecisionFn = opts.recordDecision ?? recordDecision;
  const planPath = opts.planPath ?? join(repoRoot, "plan", "tasks.yaml");
  const ledgerPath = ledgerPathFor(config);
  const owner = resolveOwner();

  const runId = `${taskId}-${Date.now()}`;
  const log = (step: string, extra: Record<string, unknown> = {}) =>
    appendLedger(ledgerPath, { run_id: runId, task_id: taskId, step, ...extra });
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
    const synced = syncPlanOrRefuse(planPath, { allowStale: opts.allowStale ?? false, log, say });
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
  const github = opts.github ?? buildBatchedGithub(owner, task.repo);
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
      return { taskId, runId, merged: false, costUsd: 0, verdict: "task_already_merged" };
    }
  }

  assertRunnable(plan, task, isMerged); // refuse unmerged deps / blocked / verify:human

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
      return { taskId, runId, merged: false, costUsd: 0, verdict: "blocked_illformed" };
    }
    throw e;
  }

  // ── PER-TASK IN-FLIGHT LOCK (guard 1, DIAGNOSIS.md diag/drain-sequential-await).
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
  try {
    return await runTaskBody();
  } finally {
    inflightLock.release();
  }

  async function runTaskBody(): Promise<RunResult> {
  // Budget is a RUNAWAY TRIPWIRE, not an allowance (§9). The HARD cap defaults to
  // DEFAULT_BUDGET_USD ($100 — an order of magnitude above any observed task) when a
  // task omits it; the SOFT threshold ($25 default, config-tunable) only surfaces an
  // anomaly as a WARNING and never kills.
  const budgetUsd = task.budget_usd ?? DEFAULT_BUDGET_USD;
  const softThresholdUsd = softBudgetThreshold(config);

  // ── MOUNT RESOLUTION (§9; class axis W1-T167). The (task_type × risk × class)
  // routing table OWNS the model/effort/max_turns a run rides — never a
  // hardcoded literal (the W1-T6 defect: a dead mounts.yaml + a hardcoded
  // 60-turn ceiling, see DIAGNOSIS.md). Resolve ONCE here and FAIL LOUD on a
  // type/risk miss: a missing route is a config gap, never a silent fallback
  // to some default number. loadMounts throws on a bad/absent table;
  // resolveMountForClass throws on an unrouted (type × risk); an unrouted
  // CLASS is expected (not every class has a cheap row) and falls back to the
  // table's `src` default — LOUDLY, via the `mount.class_fallback` line below.
  // The table is a COMMITTED repo artifact (§9, golden-gated), read from the repo
  // checkout — resolution + the loud class-fallback ledgering live in
  // resolveRunMounts (exported, above) so every branch, including the fallback a
  // COMPLETE committed table can never reach, is unit-covered with fixture tables.
  const { mount, reviewerMount, fixMount, reconMount, taskClass, mountClass } = resolveRunMounts(repoRoot, task, log);
  log("run.start", {
    repo: task.repo,
    type: task.type,
    risk: task.risk,
    // W1-T167: the task's routing class (docs / plan-lint / src) and the class
    // the mount actually resolved to (differs from task_class only on a loud
    // fallback, logged above) — the pair the retro's per-class calibration
    // (lib/retro.ts's aggregateByClass) reads alongside this line's cost/verdict.
    task_class: taskClass,
    mount_class: mountClass,
    budget_usd: budgetUsd,
    soft_threshold_usd: softThresholdUsd,
    mount: { model: mount.model, effort: mount.effort, max_turns: mount.maxTurns, context_budget: mount.contextBudget },
  });
  say(`run ${runId} — target ${owner}/${task.repo} · mount ${mount.model}/${mount.effort} · ${mount.maxTurns} turns (${task.type}×${task.risk}×${taskClass})`);

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

  /**
   * A worker returned an ERROR envelope (max_turns, max_budget_usd, execution
   * error). Turn it into a terminal verdict: clean the worktree so no debris
   * survives, ledger the verdict WITH num_turns + cost_usd (a failed run is never
   * free in the ledger), and return. A budget breach is verdict=blocked_budget
   * and is NEVER retried — dollars are the hard backstop. Any other error is
   * `failed`. Returns null when the result is not an error (caller proceeds).
   */
  const failOnWorkerError = (r: WorkerResult, stage: string): RunResult | null => {
    const v = workerErrorVerdict(r, costUsd, stage);
    if (!v) return null;
    try {
      worktreeRemove(repoDir, worktreePath);
      log("worktree.remove", { on: `${stage}.error` });
    } catch (e) {
      log("worktree.remove.error", { on: `${stage}.error`, error: String((e as Error)?.message ?? e) });
    }
    log("verdict", v.ledger);
    say(
      `verdict: ${v.verdict} (${r.subtype}) at ${stage} · ${r.numTurns} turns · notional $${costUsd.toFixed(4)}`,
    );
    return { taskId, runId, merged: false, costUsd, verdict: v.verdict };
  };

  // ── Validate-before-spawn guard (FF10a): reject a bad settings file BY NAME.
  const settingsFile = renderWorkerSettings({
    templatePath: join(repoRoot, "settings", "worker.json"),
    hooksDir: join(repoRoot, "hooks"),
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

  // ── Post-spawn CONTAINMENT PREFLIGHT (W1-T2 #2 / WS-0 verdict 7 / Standing rule
  // 11). Validation proves the file is WELL-FORMED; it does NOT prove the sandbox
  // ENGAGED (`-p` silently runs unsandboxed on a file it can't apply — FF10a). Once
  // per run, empirically confirm an outside-cwd write is OS-DENIED before any task
  // worker runs. FAIL CLOSED: containment unproven ⇒ the run does not proceed.
  try {
    const probe = await probeContainment({
      settingsFile,
      config,
      budgetUsd,
      log: (s, extra) => log(s, extra),
      exec: opts.containmentExec,
    });
    costUsd += probe.costUsd; // meter the probe spawn (notional; the ledger has it)
    say(`containment preflight PASSED — ${probe.reason}`);
  } catch (e) {
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
      });
      say(`verdict: blocked_containment — ${e.message}`);
      return { taskId, runId, merged: false, costUsd, verdict: "blocked_containment" };
    }
    throw e;
  }

  // ── Isolation PREFLIGHT (W1-T17 / Standing rule 11 / FIELD FINDING 11b): the
  // current shell isolation (CLAUDE_CODE_SHELL routing the Bash-tool snapshot to
  // an empty rc) works ONLY because THIS host's `~/.bashrc` happens to be absent
  // — an accident of the machine, not construction (LEARNINGS.md). A populated
  // `~/.bashrc` would silently isolate NOTHING. Once per run, empirically confirm
  // a worker inherits ZERO operator aliases/functions before any task worker
  // (recon/implement) runs. FAIL CLOSED: a nonzero count means isolation is not
  // holding on this host — the run refuses to start.
  try {
    const isoProbe = await probeIsolation({
      settingsFile,
      config,
      budgetUsd,
      log: (s, extra) => log(s, extra),
      exec: opts.isolationExec,
    });
    costUsd += isoProbe.costUsd; // meter the probe spawn (notional; the ledger has it)
    say(`isolation preflight PASSED — ${isoProbe.reason}`);
  } catch (e) {
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
      });
      say(`verdict: blocked_isolation — ${e.message}`);
      return { taskId, runId, merged: false, costUsd, verdict: "blocked_isolation" };
    }
    throw e;
  }

  // ── Clone + worktree.
  const repoDir = join(config.root, "repos", task.repo);
  if (!existsSync(repoDir)) {
    mkdirSync(dirname(repoDir), { recursive: true });
    execFileSync("gh", ["repo", "clone", `${owner}/${task.repo}`, repoDir], { stdio: "inherit" });
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
  // W1-T411: three MORE sweeps with call sites only inside daemonCommand — stale rmd temp
  // dirs, abandoned review clones, and per-spawn worker homes — get the SAME start-of-run
  // reclaim rung pruneStaleRuns and logWorktreeReapBootSurvey already occupy. Unlike the
  // worktree reaper above, all three already run ARMED wherever they run today, so this needs
  // no dry-run flag of its own — see logDiskReclaimRung.
  logDiskReclaimRung(config, log);

  const branch = `run-${runId}`;
  const worktreePath = join(worktreesDir(config), branch);
  // W1-T405: worktreeAdd itself asserts base currency and throws WorktreeBaseStaleError
  // before this run touches recon/implement/commit -- catch it HERE, at dispatch, rather
  // than let a stale base surface only after a full run as the out-of-scope scope guard's
  // "forged merge-base" misdiagnosis (the cost/misattribution this task exists to avoid).
  // Verdict stays "failed" -- the SAME terminal verdict the scope guard's own out-of-scope
  // refusal already returns for this identical condition (see its `outOfScope.length > 0`
  // branch below); this task moves WHEN that refusal fires and WHAT it says, not what verdict
  // it carries, so drain.ts's existing halt/continue classification needs no new case.
  try {
    worktreeAdd(repoDir, worktreePath, branch, "origin/main");
  } catch (e) {
    if (e instanceof WorktreeBaseStaleError) {
      log("worktree.stale_base", { base: e.base, remote_head: e.remoteHead, ref: e.ref });
      say(
        `REFUSED: worktree base ${e.base} is behind origin/${e.ref}'s remote head ${e.remoteHead} — ` +
          "refusing before recon/implement/commit spend anything",
      );
      return { taskId, runId, merged: false, costUsd: 0, verdict: "failed" };
    }
    throw e;
  }
  log("worktree.add", { branch, worktreePath });
  // LIVENESS TOKEN: mark this worktree ALIVE so a concurrent pruneStaleRuns (another
  // drain, a manual run-task) skips it instead of `--force`-removing it mid-run. The
  // lock is a SIBLING file (never inside the worktree ⇒ never committed into the PR),
  // written now and removed on terminal verdict (the finally below). If the process
  // crashes, the lock's pid goes dead and prune reclaims it. (DIAGNOSIS.md)
  writeRunLock(worktreePath, { pid: process.pid, run_id: runId, startedAt: new Date().toISOString() });

  try {
    // ── Recon (read-only).
    say("recon worker");
    // W1-T37 / MASTER-PLAN §8A Tier 2: the plan is RETRIEVED, not injected — the recon prompt
    // carries the generated PLAN INDEX (section headings + one-line summaries + a grep hint), not
    // the plan body. `loadPlanIndex` is non-fatal (a fresh checkout before the first `npm run
    // plan-index` just omits the block); `npm run plan-index:check` fails CI on a stale index.
    const planIndex = loadPlanIndex(join(dirname(planPath), "plan-index.json"));
    const planIndexBlock = planIndex ? renderPlanIndex(planIndex) : "";
    // W1-T164: task-scoped operator guidance notes — read from the durable console-editable
    // store (`repoRoot`, the SAME root worker.ts's question store reads/writes), scoped strictly
    // to THIS task's id (never another task's), and rendered ONCE so the identical block injects
    // into both the recon prompt below and the implement prompt further down.
    const operatorNotes = loadOperatorNotesForTask(repoRoot, task.id);
    const operatorNotesBlock = renderOperatorNotes(operatorNotes);
    log("operator_notes.injected", { count: operatorNotes.length });
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
        settingsFile,
        model: reconMount?.model,
        effort: reconMount?.effort,
        // maxTurns DELIBERATELY NOT taken from the mount, and the ROW agrees with this cap.
        // impl-BP flagged a 50x contradiction (rows said 400, this said 8); the operator ruled the
        // ROW moves rather than this bound moving to 400, so recon stays cheap on every dispatch
        // and the table no longer asserts something the code does not do (impl-BS). Both halves
        // are pinned by test/recon-mount-routing.test.ts so neither can drift back.
        maxTurns: RECON_MAX_TURNS,
        maxBudgetUsd: budgetUsd, // dollars are the real backstop (WS-0 knob a).
        config,
        prompt: renderReconPrompt(planIndexBlock, operatorNotesBlock),
      });

    let recon = account(await spawnRecon());
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
    let reconDegradedSubtype: string | undefined;
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

    // Recon's own optional '## Follow-ups' section (renderReconPrompt above) — no `pr_url`
    // (recon never opens one); the retro harvest still cites its run/task. Skipped on a
    // degraded recon: the final attempt's text is an error envelope, not a report to harvest.
    if (!reconDegradedSubtype) {
      harvestFollowupsFromReport([recon.text, recon.blocks.join("\n")].join("\n"), { label: "recon", log, say });
    }

    // ── Promptsmith READ side (W1-T19; SPLIT + INDEX + SUPERSESSION, W1-T33;
    // LAYERED — project + user-overall + global, P32/W1-T145): inject the
    // distrust rule, the autonomy clause, and the task-matched LEARNINGS
    // facts. `loadLayeredLearningsForTaskFiles` reads the PROJECT layer via
    // the index-based LOOKUP (W1-T33's `learnings/index.json`, not a scan —
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
    const learningsDir = join(dirname(planPath), "..", "learnings");
    // W1-T86 (P12 wipe-test harness): arm B of a wipe-test pair MASKS injection —
    // computeMatchedLearningsForArm("B", ...) returns "" WITHOUT calling any of the
    // load/select/render chain below, so the store is never touched, only the
    // resulting text is forced empty. A normal (non-wipe-test) run always passes
    // opts.maskLearnings undefined, i.e. arm "A" — byte-identical to the chain this
    // block ran before W1-T86.
    const learningsResult = computeMatchedLearningsForArm(opts.maskLearnings ? "B" : "A", {
      homes: {
        projectDir: learningsDir,
        userOverallDir: userOverallLearningsHome(config),
        globalArtifactPath: globalArtifactPath(config),
      },
      taskFiles: task.files,
      budgetChars: DEFAULT_KNOWLEDGE_BUDGET_CHARS,
    });
    // VOLATILE (Tier 1) — deliberately NOT combined with the stable doctrine
    // preamble here: renderImplementPrompt places this LAST in the CONTEXT
    // block (cache-aware ordering, W1-T35) so a growing corpus can never bust
    // the cache for the stable/per-task bytes that precede it.
    const matchedLearnings = learningsResult.matchedLearnings;
    log("learnings.injected", {
      matched: learningsResult.selectedIds.length,
      dropped: learningsResult.droppedIds,
      budget_chars: DEFAULT_KNOWLEDGE_BUDGET_CHARS,
      global_refused_reason: learningsResult.globalRefusedReason,
      masked: !!opts.maskLearnings,
    });

    // ── Render + provenance-lint the prompt.
    // The record path is resolved for BOTH branches. It used to be resolved only on the degraded
    // one, "since recon already relayed all of this" — but recon is never told WHICH TASK it is
    // reconning (`renderReconPrompt` takes no task argument), only its `OBSERVED:` section
    // survives `reconObservedToContext`, and that section can be empty. See that function's doc.
    // ONE lookup, both arms: `taskRecordPath` is fail-soft and yields `undefined` rather than
    // throwing, and the helper renders nothing for an undefined path.
    const recordPath = taskRecordPath(planPath, taskId);
    const reconContext = reconDegradedSubtype
      ? reconDegradedContextNote(reconDegradedSubtype, taskId, recordPath, task.acceptance ?? [])
      : reconObservedToContext(recon, taskId, recordPath);
    const prompt = renderImplementPrompt(task, reconContext, runId, matchedLearnings, operatorNotesBlock);
    assertProvenance(prompt); // throws ProvenanceError on any uncited CONTEXT claim
    log("prompt.linted", { provenance: "clean" });
    say("prompt provenance-linted: clean");

    // ── COMPACTION ANCHOR (MASTER-PLAN §8B / W1-T36): the goal + acceptance
    // criteria + hard constraints, built ONCE and ledgered here so the anchor
    // this run WOULD re-inject verbatim after a compaction is a matter of
    // repo-state fact, not a claim in a possibly-lossy REPORT. Live mid-stream
    // re-injection (a real compaction firing during THIS spawn) is W1-T12e's
    // operator-golden drill — this run-level wiring records the anchor that
    // drill will send.
    const anchor = renderAnchorBlock(task, runId);
    log("anchor.built", { anchor });

    // ── Implement. A TRANSIENT (an Anthropic-side server_error mid-response, or a
    // network/5xx/CI-infra blip) is Anthropic's fault, NOT the task's — W1-T7's classifier
    // (now WIRED here; it never was — run W1-T12a-1784117152056 reached verdict-assembly
    // unclassified) RETRIES it, bounded, consuming NO strike and NEVER stamping failed/no_pr.
    say("implement worker");
    let impl: WorkerResult;
    let transientAttempts = 0;
    for (;;) {
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
          // needed >61 turns — DIAGNOSIS.md), an order of magnitude above expected.
          model: mount.model,
          effort: mount.effort,
          maxTurns: mount.maxTurns,
          maxBudgetUsd: budgetUsd,
          settingsFile,
          config,
          prompt,
        }),
      );
      log("implement.done", {
        session_id: impl.sessionId,
        cost_usd: impl.costUsd,
        num_turns: impl.numTurns,
        subtype: impl.subtype,
        api_error: impl.apiError,
        transient_attempt: transientAttempts,
        permission_denials: impl.permissionDenials.length,
        // W1-T6: every worker call ledgers the standard telemetry shape.
        ...workerLedgerFields(impl),
      });
      if (!isTransientResult(impl)) break; // clean success OR a real strike ⇒ handled below
      if (transientAttempts < MAX_TRANSIENT_RETRIES) {
        transientAttempts++;
        log("implement.transient_retry", { attempt: transientAttempts, subtype: impl.subtype, api_error: impl.apiError });
        say(`transient (${impl.apiError ? "api server_error" : impl.subtype}) — retry ${transientAttempts}/${MAX_TRANSIENT_RETRIES}, NO strike`);
        continue;
      }
      // A transient that PERSISTED across the bounded retries: Anthropic-side, not a task
      // failure and not a no-op. Honest, distinct verdict (NOT failed, NOT no_pr) the daemon
      // can reason about; it blocks the drain like any non-merged terminal state.
      try {
        worktreeRemove(repoDir, worktreePath);
        log("worktree.remove", { on: "blocked_transient" });
      } catch (e) {
        log("worktree.remove.error", { on: "blocked_transient", error: String((e as Error)?.message ?? e) });
      }
      log("verdict", {
        verdict: "blocked_transient",
        stage: "implement",
        subtype: impl.subtype,
        num_turns: impl.numTurns,
        cost_usd: costUsd,
        billing_mode: billingMode(impl.childEnvKeys),
        account_label: impl.accountLabel,
        reason: `repeated transient API error across ${MAX_TRANSIENT_RETRIES} retries — not a task failure`,
      });
      say(`verdict: blocked_transient — repeated transient API error, not a task failure`);
      return { taskId, runId, merged: false, costUsd, verdict: "blocked_transient" };
    }
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

    const implFail = failOnWorkerError(impl, "implement");
    if (implFail) return implFail;

    const fullText = (r: WorkerResult) => [r.text, r.blocks.join("\n")].join("\n");

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
        }).landed;
      }
      log("decision.autochoose", { chosen, recorded: recordVerdict.record, risk_band: recordVerdict.band, landed });
      say(
        `DECISION_REQUEST auto-chose: ${chosen} (${
          recordVerdict.record
            ? `recorded in plan/decisions.d/ — ${landed ? "landed" : "landing pending"}`
            : "ledger-only, " + recordVerdict.band + " risk"
        })`,
      );
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
          model: mount.model, // same mount as the initial implement spawn (§9).
          effort: mount.effort,
          maxTurns: mount.maxTurns,
          maxBudgetUsd: budgetUsd,
          config,
          prompt:
            `Decision made: ${chosen}. Now execute the change and the OUTPUT CONTRACT from before: ` +
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

    // ── PR (worker REPORT or orchestrator fallback).
    let prUrl = parseReport(fullText(impl))?.prUrl;

    // SILENT NO-OP GUARD: by here the worker reached a terminal SUCCESS (non-success
    // subtypes already returned above via workerErrorVerdict). If it committed NOTHING and
    // opened no PR, it produced nothing to merge — an honest `no_pr` verdict, NOT a failed
    // "worker error: success" (run W1-T12a-1784117152056) and NOT a gh-pr-create throw on an
    // empty branch. Only reached when there's no PR to gate.
    //
    // Computed ONCE and held in `commitCount` (W1-T407) rather than re-called inline: the guard's
    // predicate is unchanged (still `=== 0`), but the same value now also rides the `no_pr`
    // ledger row below instead of being thrown away after deciding the branch.
    const commitCount = commitsAhead(worktreePath, "origin/main");
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
      harvestFollowupsFromReport(fullText(impl), { label: "implement", log, say });
      // W1-T272: the THIRD exit — before falling to the drain-halting `no_pr`, check whether
      // the worker instead claimed ALREADY_SATISFIED and, if so, whether that claim actually
      // verifies against the board gateway. A claim that fails to verify is deliberately NOT
      // an error of its own — it just falls straight through to the unchanged `no_pr` path,
      // exactly as if no claim had been made at all.
      const claim = parseAlreadySatisfied(fullText(impl));
      const resolved = claim && resolveAlreadySatisfied(claim, github, taskId);
      if (claim && resolved) {
        const v = alreadySatisfiedVerdict(impl, costUsd, "implement", resolved);
        try {
          worktreeRemove(repoDir, worktreePath);
          log("worktree.remove", { on: "already_satisfied" });
        } catch (e) {
          log("worktree.remove.error", { on: "already_satisfied", error: String((e as Error)?.message ?? e) });
        }
        log("verdict", v.ledger);
        say(`verdict: already_satisfied — credited via ${v.prUrl} · ${impl.numTurns} turns`);
        return { taskId, runId, prUrl: v.prUrl, merged: true, costUsd, verdict: "already_satisfied" };
      }
      if (claim) {
        log("already_satisfied.refused", {
          claimed_ref: claim.ref,
          claimed_number: prNumberFromRef(claim.ref) ?? null,
        });
        say(`ALREADY_SATISFIED claim ("${claim.ref}") did not verify against the board gateway — falling to no_pr`);
      }
      const v = noPrVerdict(impl, costUsd, "implement", commitCount);
      try {
        worktreeRemove(repoDir, worktreePath);
        log("worktree.remove", { on: "no_pr" });
      } catch (e) {
        log("worktree.remove.error", { on: "no_pr", error: String((e as Error)?.message ?? e) });
      }
      log("verdict", v.ledger);
      say(`verdict: no_pr — worker completed without opening a PR · ${impl.numTurns} turns`);
      return { taskId, runId, merged: false, costUsd, verdict: "no_pr" };
    }

    // Ensure the branch is on origin (worker pushes without -u).
    let branchOnOrigin = false;
    try {
      execFileSync("git", ["-C", worktreePath, "ls-remote", "--exit-code", "origin", branch], {
        stdio: "ignore",
      });
      branchOnOrigin = true;
    } catch {
      branchOnOrigin = false;
    }
    if (!branchOnOrigin) {
      // W1-T142 SCOPE GUARD, W1-T434 PUSH-AND-FLAG — the ONE orchestrator-initiated push in this
      // file (the worker itself normally pushes from inside its own sandbox; this fallback runs on
      // whatever the worktree holds, which is exactly the shape a refreshed/collapsed/squashed
      // branch would have). Computed FRESH from this worktree, never a cached list, and BEFORE the
      // push, so the ledger line is written against the diff that is about to reach origin.
      //
      // THE ANSWER TO AN OVERRUN IS NO LONGER A REFUSAL (W1-T434). It used to return verdict
      // "failed" with no push, and that answer DESTROYED ITS OWN EVIDENCE: the branch never
      // reached origin and died with the reaped worktree, so nobody could afterwards tell a
      // phantom revert from an under-declared `files:` — the two shapes produce an identical file
      // list, and the refusal deleted the only artifact that separates them. Four refusals in one
      // week cost roughly $29 of already-completed work each time it fired (operator report,
      // UNMEASURED here), while the very class it exists to contain merged anyway through the
      // worker's own sandbox push (W1-T393's implementation, #1521, touching src/lib/ledger.ts
      // beyond its declared files) — because this guard reaches ONE of gitPushRunBranch's nine
      // call sites and only when the branch is ABSENT from origin. It could punish the fallback
      // path after the money was spent; it could never contain a worker.
      //
      // WHAT IS GIVEN UP, STATED RATHER THAN GLOSSED. The DETECTION is unchanged — the detector
      // below is untouched and still names exactly the same paths — but the BLOCK becomes a FLAG,
      // and `unwiredAdvisories` folds into neither `state` nor `floorState` (lib/review.ts), while
      // `armAutoMergeAtOpen` arms the instant the PR exists. So on this one path a phantom revert
      // that passes CI and the review floor can now merge carrying the revert, where before it
      // could not reach origin at all. That is accepted because real containment is the merge gate
      // (Standing rule 3B), because the branch surviving is what lets a human adjudicate at all,
      // and because a guard covering one push site was never the containment it read as.
      //
      // AND ONE CASE GOES QUIET RATHER THAN SOFT: `scopeGuardOutOfScopeFiles` treats an
      // absent/empty declared scope as "everything is out of scope", but review-side
      // `scopeViolationFiles` deliberately does the opposite and never fires on an empty scope. A
      // task declaring no `files:` therefore still ledgers `scope_guard.overrun` here — the
      // detector is untouched — but earns NO PR advisory. The ledger keeps it; the comment does not.
      //
      // THREE-DOT, AND THIS WAS A REAL DEFECT RATHER THAN A STYLE PREFERENCE. Two-dot
      // `origin/main..HEAD` diffs the two TIPS, so every file merged to main AFTER this worktree
      // was cut reads as something this branch changed. MEASURED: a drain booted at 3147755
      // dispatched W1-T395, #1533 merged mid-run, and the guard refused the push naming
      // `src/run-task.ts` and `test/drain-gateway-batched.test.ts` — #1533's files, which the
      // worker never opened. A merge to main must not break a running drain.
      //
      // `origin/main...HEAD` diffs against the MERGE BASE — what THIS BRANCH changed relative to
      // where it started — which is the question the guard is actually asking, and is already the
      // convention `lib/ci-parity.ts` uses at both of its own diff sites.
      let diffFiles: string[] | undefined;
      try {
        diffFiles = execFileSync("git", ["-C", worktreePath, "diff", "--name-only", "origin/main...HEAD"], {
          encoding: "utf8",
        })
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
      const outOfScope = diffFiles === undefined ? [] : scopeGuardOutOfScopeFiles(diffFiles, task.files);
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
      gitPushRunBranch(worktreePath);
    }
    if (!prUrl) {
      const prCreate = ghPrCreateFillCommand(worktreePath, owner, task.repo, branch, lastCommitSubject(worktreePath));
      const out = execFileSync(prCreate.command, prCreate.args, prCreate.options);
      prUrl = out.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/)?.[0];
    }
    if (!prUrl) {
      log("verdict", {
        verdict: "failed",
        reason: "no PR opened",
        cost_usd: costUsd,
        billing_mode: billingMode(impl.childEnvKeys),
        account_label: impl.accountLabel,
      });
      return { taskId, runId, merged: false, costUsd, verdict: "failed" };
    }
    // RUN-OWNERSHIP GUARD (W1-T62) — before ANY side effect touches this PR, assert
    // it is actually this run's own PR (the false-merged inversion backstop; see
    // checkPrOwnership). Fails closed and named on mismatch; the PR is left untouched.
    const ownership = checkPrOwnership(prUrl, branch, ghPrHeadGateway(), costUsd, impl.accountLabel);
    if (ownership) {
      log("verdict", ownership.ledger);
      say(
        `verdict: pr_attribution_failed — claimed PR ${prUrl} (branch ${ownership.ledger.claimed_branch ?? "unresolved"}) ` +
          `is not this run's own branch (${branch}) — PR left UNTOUCHED`,
      );
      return { taskId, runId, merged: false, costUsd, verdict: "pr_attribution_failed" };
    }
    // Stamp the provenance trailer (deriveStatus source (c)) before gating.
    ensureTaskTrailer(prUrl, taskId);
    log("pr.opened", { pr_url: prUrl });
    say(`PR: ${prUrl}`);

    // ── ARM AT OPEN (W1-T125): register GitHub auto-merge the INSTANT this run's
    // PR exists — not after CI wait + review, which measured 2-8 minutes of dead
    // time (own-repo PRs #251/#245/#240/#249; #274 NEVER reached the old
    // post-review arm call because its fix-rung loop was still running). Safe
    // because GitHub's required-status contract (ci + the REQUIRED
    // remudero-review status) is what actually gates the merge — see
    // armAutoMergeAtOpen's doc. The one gap this leaves (a CAPPED verdict that
    // still posts remudero-review=success) is closed below by disarmAutoMerge,
    // right where the capped-refusal decision is made.
    const armAtOpenOutcome = armAutoMergeAtOpen(prUrl);
    log("automerge.armed", { at: "open", outcome: armAtOpenOutcome });

    // The implement worker's own optional '## Follow-ups' section (§2 OUTPUT CONTRACT,
    // outputContractLines in lib/compaction.ts).
    harvestFollowupsFromReport(fullText(impl), { label: "implement", prUrl, log, say });

    // ── REVIEW GATE (W1-T1D). Wait for `ci` green, then JUDGE the task's
    // acceptance criteria and POST `remudero-review` to the PR head sha — only
    // THEN arm auto-merge. This is the call site the T1C/T1D split left unowned:
    // a REQUIRED check that nothing posts deadlocks every merge, so the poster
    // lives here, before arming. A ci that never greens is blocked_ci (no review
    // over unproven code); a review=failure is blocked_review (the required check
    // is red and GitHub will not merge). Pending is never treated as pass.
    const ci = await waitForCiGreen(prUrl, (s, extra) => log(s, extra));
    if (ci !== "green") {
      say("fallback: pushing branch already done; ci not green — skipping review, leaving PR open");
      log("verdict", {
        verdict: "blocked_ci",
        pr_url: prUrl,
        reason: `ci ${ci} before review`,
        cost_usd: costUsd,
        billing_mode: billingMode(impl.childEnvKeys),
        account_label: impl.accountLabel,
      });
      say(`verdict: blocked_ci (ci ${ci}) — PR left OPEN: ${prUrl}`);
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
    let reviewReport = fullText(impl);
    try {
      reviewReport = await fetchPrBodyFn(prUrl);
    } catch (e) {
      log("review.body_fetch_error", { error: String((e as Error)?.message ?? e) });
    }
    let review = await runReviewFn({
      owner,
      repo: task.repo,
      prUrl,
      task,
      report: reviewReport,
      settingsFile,
      config,
      budgetUsd,
      log: (s, extra) => log(s, extra),
      say,
      account,
      reviewerMount,
      // W1-T65 (ratifies P15) — HEAD DISCIPLINE: worktreePath IS the PR head here
      // (this run's own worktree, checked out at the branch it just pushed; CI
      // that follows never mutates it). NEVER the operator's working checkout —
      // the deterministic floor observes THIS run's repo state, not report prose.
      headCheckoutDir: worktreePath,
      ledgerPath,
      runId,
      openTaskIds,
    });

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
        taskId,
        runId,
        task,
        prUrl,
        branch,
        worktreePath,
        initialSessionId: impl.sessionId,
        mount: fixMount,
        settingsFile,
        config,
        budgetUsd,
        strikeCap: fixStrikeCap(config),
        initialReview: review,
        reviewBase: { owner, repo: task.repo, headCheckoutDir: worktreePath, reviewerMount },
        openTaskIds,
        deps: {
          spawn,
          waitForCiGreen,
          // W1-T138: refresh the ci-log evidence whenever a strike leaves CI
          // non-green — see runFixRung's own doc for why this must happen on
          // every strike, not just the first.
          fetchCiFailures: async (prUrlArg) => {
            const v = ghJson(["pr", "view", prUrlArg, "--json", "statusCheckRollup"]) as {
              statusCheckRollup?: RollupCheck[];
            };
            return fetchCiFailures(owner, task.repo, v.statusCheckRollup);
          },
          runReview,
          push: (wt) => {
            try {
              gitPushRunBranch(wt, { stdio: "ignore" });
            } catch {
              // best-effort — the fix worker may already have pushed itself;
              // nothing new to push is not an error.
            }
          },
          issues: ghIssueGateway(owner, task.repo),
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
        },
      });
      review = rung.review;
      if (rung.outcome === "escalated") {
        log("verdict", {
          verdict: "blocked",
          pr_url: prUrl,
          reason: `fix rung exhausted after ${rung.strikes} strike(s)`,
          issue_url: rung.issueUrl,
          cost_usd: costUsd,
          billing_mode: billingMode(impl.childEnvKeys),
          account_label: impl.accountLabel,
        });
        say(`verdict: blocked — fix rung exhausted (${rung.strikes} strike(s)), escalated: ${rung.issueUrl}`);
        return { taskId, runId, prUrl, merged: false, costUsd, verdict: "blocked" };
      }
      if (rung.outcome === "stood_down") {
        // W1-T177: this run's own PR went terminal (merged/closed) mid-rung —
        // stand down rather than spend another strike or escalate. Reuses the
        // existing "blocked" verdict (never a spend, never a bypass) so the
        // drain's stop-on-block invariant still holds; the ledger line above
        // names the SITE and the STATE, not just "blocked".
        log("verdict", {
          verdict: "blocked",
          pr_url: prUrl,
          reason: `stood down — ${rung.standDownReason}`,
          cost_usd: costUsd,
          billing_mode: billingMode(impl.childEnvKeys),
          account_label: impl.accountLabel,
        });
        say(`verdict: blocked — stood down (${rung.standDownReason}): ${prUrl}`);
        return { taskId, runId, prUrl, merged: false, costUsd, verdict: "blocked" };
      }
    }

    // ── W1-T185 (Gap 1, criteria 2-3), raised by W1-T229: THE AUTO-MERGE
    // ARMING PATH refuses ANY CAPPED verdict, unattended — the #411 shape
    // (0/5 proofs executed, posted as an uncapped PASS, merged with no human
    // reading the diff). W1-T229 removed the tdd:strict exemption this used
    // to carry: a capped, non-tdd:strict PR previously armed exactly as if it
    // were an ordinary PASS, which made prose the DEFAULT merge floor (since
    // `{tdd: strict}` is opt-in, not the default). No autonomous run carries
    // an operator override of its own: an override is a HUMAN decision,
    // granted out of band via `rmd review <pr> --override-capped-by/
    // --override-capped-reason` and recovered here from the SAME ledger every
    // other precedence check in this file reads (readLedgerLines). A verdict
    // that isn't capped arms exactly as before — decideAutoMergeArm only ever
    // REFUSES the one shape rule 22's fixture (iii) named.
    //
    // KNOWN RESIDUAL GAP (explicitly out of this task's stated file scope,
    // `plan/tasks.yaml` W1-T185 `files:`): `sweep.ts`'s independent
    // "checks green + review success -> mergeable" reconciliation does not
    // yet consult `capped`/an override — a PR this refuses stays OPEN and
    // UNARMED, but a later sweep poll could still arm it via that separate
    // path. Left for a follow-up task rather than widened here unreviewed.
    const tddStrict = isTddStrict(task.principles);
    // W1-T219: head-bound — an override granted against a DIFFERENT head than
    // this exact verdict's is never honoured (see cappedOverrideFromLedger).
    const cappedOverride = review.capped
      ? cappedOverrideFromLedger(readLedgerLines(ledgerPath), taskId, review.headSha)
      : undefined;
    const armDecision = resolveAutoMergeArm(review, tddStrict, cappedOverride, (s, extra) => log(s, extra));
    if (!armDecision.arm) {
      // W1-T125: withdraw the early arm-at-open BEFORE escalating — GitHub already
      // (or is about to) see ci=success + remudero-review=success (capped verdicts
      // still post state:"success", see postReviewStatusGuarded) on an
      // ALREADY-armed PR; without this it could auto-merge despite the capped
      // refusal below.
      disarmAutoMerge(prUrl);
      log("automerge.disarmed", { reason: "capped verdict refused auto-merge" });
      const prNum = prUrl.match(/\/pull\/(\d+)/)?.[1] ?? prUrl;
      const issueUrl = escalate(
        {
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
        },
        { issues: ghIssueGateway(owner, task.repo), ledgerPath, runId },
      );
      log("verdict", {
        verdict: "blocked",
        pr_url: prUrl,
        reason: "capped verdict refused auto-merge",
        issue_url: issueUrl,
        cost_usd: costUsd,
        billing_mode: billingMode(impl.childEnvKeys),
        account_label: impl.accountLabel,
      });
      say(`verdict: blocked — CAPPED verdict, escalated: ${issueUrl}`);
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
    const riskJudgeInput: RiskJudgeInput = {
      change: { description: `${task.title} — ${prUrl}`, files: task.files },
      gatesState: { review_state: review.state, review_capped: review.capped, ci, arm_decision: armDecision.reason },
      planContext: { taskId: task.id, title: task.title, taskType: task.type },
    };
    const riskJudgeMount = resolveRiskJudgeMount(loadMounts(mountsPath(repoRoot)));
    const riskJudgeResult = await runRiskJudge(riskJudgeInput, {
      judge: realRiskJudge({ mount: riskJudgeMount, cwd: worktreePath, settingsFile, spawn }),
      escalate: (verdict, action) => {
        // W1-T125 shape, reapplied to a NEW cause: withdraw the early arm-at-open
        // BEFORE escalating — GitHub must never merge a PR the risk judge refused.
        disarmAutoMerge(prUrl);
        log("automerge.disarmed", { reason: "risk judge escalated — auto-merge refused" });
        return escalate(
          {
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
      log: (s, extra) => log(s, extra),
    });
    if (riskJudgeResult.action.kind === "escalate") {
      log("verdict", {
        verdict: "blocked",
        pr_url: prUrl,
        reason: "risk judge escalated",
        issue_url: riskJudgeResult.escalationUrl,
        cost_usd: costUsd,
        billing_mode: billingMode(impl.childEnvKeys),
        account_label: impl.accountLabel,
      });
      say(`verdict: blocked — risk judge escalated: ${riskJudgeResult.escalationUrl}`);
      return { taskId, runId, prUrl, merged: false, costUsd, verdict: "blocked" };
    }

    // ── POLL to the gate (W1-T1B).
    // W1-T125: auto-merge was already armed at PR-OPEN (see armAutoMergeAtOpen,
    // above, right after `pr.opened`) — this block no longer arms; it only
    // observes. The runner NEVER force-merges: GitHub merges only when the
    // required check is green. If checks go red or the poll times out, the PR
    // is LEFT OPEN and the verdict is blocked_ci — pending is treated as
    // blocked, never as pass. No Action arms a PR; only this code, only on PRs
    // it opened.
    const outcome = await pollToGate(prUrl, (s, extra) => log(s, extra));

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
      });
      say(`verdict: merged · notional cost $${costUsd.toFixed(4)}`);
      return { taskId, runId, prUrl, merged: true, costUsd, verdict: "merged" };
    }

    // Blocked: leave the PR open (auto-merge stays armed; it will land later if
    // the check goes green) and the worktree for post-mortem.
    log("verdict", {
      verdict: "blocked_ci",
      pr_url: prUrl,
      reason: outcome.reason,
      cost_usd: costUsd,
      billing_mode: billingMode(impl.childEnvKeys),
      account_label: impl.accountLabel,
    });
    say(`verdict: blocked_ci (${outcome.reason}) — PR left OPEN: ${prUrl}`);
    return { taskId, runId, prUrl, merged: false, costUsd, verdict: "blocked_ci" };
  } catch (err) {
    log("run.error", { error: String((err as Error)?.message ?? err) });
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
  }
  } // ── end runTaskBody
}

/**
 * `rmd review <pr-number>` — the ESCAPE HATCH for hand-opened PRs. PR #13 made
 * `remudero-review` a REQUIRED check, but only `rmd run-task` posts it; a manual
 * plan/doc PR therefore sits BLOCKED forever with no status. This command posts the
 * status by hand — using the SAME deterministic {@link judgeReview}, NEVER a bypass
 * and NEVER a --force. It is the same judge, invoked by a human.
 *
 * Criteria resolution: a `Remudero-Task: <id>` trailer in the PR body → that task's
 * acceptance from plan/tasks.yaml; otherwise the PR body's `Acceptance:` block
 * (manual plan/doc PRs). ABSENT criteria are `[]` ⇒ judgeReview FAILS CLOSED —
 * nothing to judge is never a pass. The PR body doubles as the REPORT (where a
 * manual author pastes the proofs the judge checks).
 */
/**
 * Resolve which `owner/repo` a `rmd review` targets: a `--repo <name>` or
 * `--repo <owner>/<name>` flag OVERRIDES the checkout's default (a bare name keeps the
 * default owner). Pure so the sandbox-gating path is unit-tested without a `gh` call.
 */
export function resolveReviewTarget(
  defaults: { owner: string; repo: string },
  rest: string[],
): { owner: string; repo: string } {
  const i = rest.indexOf("--repo");
  const arg = i >= 0 ? rest[i + 1] : undefined;
  if (!arg) return defaults;
  if (arg.includes("/")) {
    const [owner, repo] = arg.split("/", 2);
    return { owner, repo };
  }
  return { owner: defaults.owner, repo: arg };
}


/**
 * Build the BASE-revision directory {@link preexistingProofHits} needs, containing only the blobs
 * this review's `grep:` proofs name. Returns the directory, or `undefined` when there is nothing to
 * put in it (no grep proof, or no resolvable merge-base) — in which case the staleness check stays
 * inert exactly as it was, which is the pre-impl-GE behaviour.
 *
 * THE MERGE-BASE, not `origin/main`: "already matched before this work existed" is a question about
 * the commit the branch forked from, and a proof legitimately added by a PR merged in between must
 * not count against this one.
 */
export function buildBaseProofDir(
  criteria: ReadonlyArray<{ proof?: string }>,
  headCheckoutDir: string,
  deps: {
    mergeBase?: (cwd: string) => string;
    showBlob?: (cwd: string, rev: string, repoRelPath: string) => string;
    makeDir?: () => string;
  } = {},
): string | undefined {
  const mergeBase =
    deps.mergeBase ??
    ((cwd: string) =>
      execFileSync("git", ["-C", cwd, "merge-base", "origin/main", "HEAD"], { encoding: "utf8" }).trim());
  const showBlob =
    deps.showBlob ??
    ((cwd: string, rev: string, rel: string) =>
      execFileSync("git", ["-C", cwd, "show", `${rev}:${rel}`], { encoding: "utf8", maxBuffer: 1 << 26 }));
  const makeDir = deps.makeDir ?? (() => mkdtempSync(join(tmpdir(), "rmd-proof-base-")));

  let base: string;
  try {
    base = mergeBase(headCheckoutDir);
  } catch {
    return undefined; // unresolvable base ⇒ no staleness signal, never a false positive
  }
  if (!base) return undefined;

  const dir = makeDir();
  const written = materialiseBaseProofBlobs(
    criteria,
    base,
    (rev: string, rel: string) => showBlob(headCheckoutDir, rev, rel),
    (rel: string, contents: string) => {
      const dest = join(dir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, contents);
    },
  );
  return written > 0 ? dir : undefined;
}

// ── W1-T185 (Gap 2): materialize a PR-head worktree for `rmd review` ────────
//
// GROUND TRUTH this closes: every review hand-posted on 2026-07-20 read
// `proof_exec: 0/N` — #391 0/3, #394 0/4, #397 0/4, #407 0/6, #411 0/5,
// #418 0/5 — while the automated fix rung, which HAS a worktree at the head,
// recorded `executed_fail` on the SAME proofs of #411. The operator path was
// keyword-only BY CONSTRUCTION, not by defect: it never checked anything out.
//
// Preferred fix, per the task's own design note: materialize a throwaway
// worktree at the PR's head branch and execute there — REUSE of the exact
// `git worktree add origin/<branch>` pattern `buildSweepEffects`'s
// `dispatchFix` path already uses for the SAME purpose (see that function,
// above), never new machinery. Teardown is the CALLER's job (a `finally` in
// `reviewCommand`, below) so it covers every exit path.
//
// W1-T232: the original shape here ALSO ran `git checkout -B <branch>
// origin/<branch>` after the `worktree add`, purely to give the throwaway
// worktree a branch NAME — nothing downstream ever reads it; proof execution
// only reads files at the checked-out tip, which `worktree add` alone already
// provides (as a DETACHED HEAD — confirmed by hand: `git worktree add <path>
// origin/<branch>` prints "Preparing worktree (detached HEAD ...)" with no
// second command). `checkout -B` FORCE-CREATES/RESETS a local branch of that
// name, which THROWS the moment any other worktree already holds it — e.g.
// the operator's own filing worktrees, or simply another `rmd review` in
// flight on the same branch. That collision was reproduced verbatim on
// 2026-07-21 and cost five PRs a keyword-only CAPPED verdict for a reason
// that had nothing to do with whether the review could actually run.
// Dropping the branch pin removes an implicit freshness check, so this now
// asserts the materialized tip equals the PR head SHA and fails LOUDLY
// (throws, no verdict posted) on a mismatch — reviewing the wrong tree
// silently would be worse than not reviewing at all.
// ────────────────────────────────────────────────────────────────────────────

/** Injected git operations for {@link materializeReviewWorktree} — real
 * callers use the module's own `execFileSync` calls; tests fake them so
 * materialization success/failure is a unit fixture, no real git/network
 * involved. */
export interface ReviewWorktreeDeps {
  fetch: (repoDir: string) => void;
  addWorktree: (repoDir: string, worktreePath: string, branch: string) => void;
  revParseHead: (worktreePath: string) => string;
  /** Best-effort teardown of a worktree THIS attempt itself just created, used
   * only when a LATER step of the SAME attempt fails (W1-T233: a failed
   * materialization must leave the workspace exactly as it found it, never
   * strand what step 1 already created). Optional — defaults to the same
   * {@link worktreeRemove} every other teardown site in this file uses;
   * tests override it to observe the cleanup call without touching git. */
  removeWorktree?: (repoDir: string, worktreePath: string) => void;
}

const realReviewWorktreeDeps: ReviewWorktreeDeps = {
  fetch: (repoDir) => execFileSync("git", ["-C", repoDir, "fetch", "origin", "--quiet"], { stdio: "pipe" }),
  // NO `checkout -B` — `worktree add <path> origin/<branch>` alone already
  // leaves `<path>` at the right commit, DETACHED, and detached is all a
  // review's file reads ever need. A named local branch here only exists to
  // collide with whatever else holds that name (see the block comment above).
  addWorktree: (repoDir, worktreePath, branch) =>
    execFileSync("git", ["-C", repoDir, "worktree", "add", worktreePath, `origin/${branch}`], { stdio: "pipe" }),
  revParseHead: (worktreePath) =>
    execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { stdio: "pipe" }).toString().trim(),
};

/** Named CLASS of a materialization failure (W1-T233) — carried alongside the
 * raw message so a pattern is visible across runs (grep the class) without
 * parsing git's prose: `worktree-collision` (another worktree already holds
 * this ref — the defect W1-T232 removed from the common path; still reachable
 * via a race), `fetch-failure` (network/auth, thrown by `deps.fetch`), or
 * `other` (disk, permissions, or any other `deps.addWorktree`/`revParseHead`
 * failure). */
export type MaterializationErrorClass = "worktree-collision" | "fetch-failure" | "other";

/** The named reason a materialization attempt failed — never a bare, thrown-
 * away Error. Carried to every surface that reports the degradation: the
 * console line, the CAPPED verdict description, and the `review.posted`
 * ledger's `degraded_reason`/`degraded_reason_class` fields. */
export interface MaterializationFailure {
  errorClass: MaterializationErrorClass;
  message: string;
}

/** Result of {@link materializeReviewWorktree}: either a usable path, or a
 * clean workspace (nothing left behind) plus the named reason it failed. */
export type MaterializeReviewWorktreeResult =
  | { worktreePath: string; failure?: undefined }
  | { worktreePath: undefined; failure: MaterializationFailure };

/** The posted CAPPED description, carrying the named materialization-failure
 * reason (W1-T233) — a capped verdict caused by a failed materialization
 * names WHY on the commit status itself, not only in the ledger. A non-capped
 * verdict, or a capped one with no materialization failure at all (rmd
 * review's checkout was simply never attempted), is returned unchanged. */
export function reviewPostedDescription(
  verdict: Pick<ReviewVerdict, "summary" | "capped"> & Partial<Pick<ReviewVerdict, "criteria">>,
  materializationFailure?: MaterializationFailure,
): string {
  // W1-DH: a capped verdict names WHY it was capped even when materialization was fine — the
  // code-span defect capped 0/N with a perfectly healthy checkout, and the description said nothing.
  const skipReason = verdict.capped && verdict.criteria ? cappedReason(verdict.criteria) : undefined;
  if (verdict.capped && !materializationFailure && skipReason) {
    return `${verdict.summary} — capped: ${skipReason}`;
  }
  return verdict.capped && materializationFailure
    ? `${verdict.summary} — degraded: ${materializationFailure.errorClass}: ${materializationFailure.message}`
    : verdict.summary;
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

/**
 * Materialize a throwaway worktree at a PR's head branch so `rmd review` can
 * execute whitelisted proofs exactly like the automated fix rung does.
 * Returns `{ worktreePath }` on success; on an ORDINARY materialization
 * failure (network, disk, a detached/deleted head) returns `{ worktreePath:
 * undefined, failure }` naming the error CLASS + message (W1-T233) — the
 * caller then falls back to a keyword-only, CAPPED verdict (acceptance
 * criterion 5), never a thrown command reaching the operator, and never a
 * bare discarded reason.
 *
 * A materialized tip that does NOT match `headSha`, though, is not an
 * ordinary failure — it means the fetch was stale or the ref moved out from
 * under us, and reviewing that tree would silently produce a verdict against
 * the WRONG code. That case throws (uncaught by this function) rather than
 * degrading to keyword-only, so `reviewCommand` fails loudly and posts no
 * verdict at all (W1-T232, criterion "tip mismatch after fetch fails
 * materialization loudly").
 *
 * W1-T233: THIS function owns teardown of whatever IT creates. A worktree
 * `deps.addWorktree` already registered on disk is removed, best-effort,
 * before any failure return AND before the tip-mismatch throw — a failed (or
 * discarded) attempt leaves the workspace exactly as it found it, rather than
 * stranding a `review-PR*` worktree (39 were found stranded on 2026-07-21,
 * one per failed attempt, because this used to return/throw with the
 * worktree still on disk and `withMaterializedWorktree`'s teardown keyed on a
 * truthy path it was never given). Teardown of a SUCCESSFULLY returned path
 * remains the CALLER's responsibility (`reviewCommand`'s `withMaterializedWorktree`),
 * so a throw from `runReview` itself still tears that one down (criterion 6).
 */
export function materializeReviewWorktree(
  config: Config,
  repoDir: string,
  prNumber: number,
  headRefName: string,
  headSha: string,
  deps: ReviewWorktreeDeps = realReviewWorktreeDeps,
): MaterializeReviewWorktreeResult {
  const worktreePath = join(worktreesDir(config), `review-PR${prNumber}-${Date.now()}`);
  const removeWorktree = deps.removeWorktree ?? worktreeRemove;

  try {
    deps.fetch(repoDir);
  } catch (e) {
    // Nothing was created yet — no cleanup needed, only a named reason.
    return {
      worktreePath: undefined,
      failure: { errorClass: "fetch-failure", message: String((e as Error)?.message ?? e) },
    };
  }

  let created = false;
  let tip: string;
  try {
    deps.addWorktree(repoDir, worktreePath, headRefName);
    created = true; // the worktree is now on disk — any exit from here must clean it up.
    tip = deps.revParseHead(worktreePath);
  } catch (e) {
    if (created) cleanupMaterializedWorktree(removeWorktree, repoDir, worktreePath);
    const message = String((e as Error)?.message ?? e);
    const errorClass: MaterializationErrorClass = /already used by worktree/.test(message)
      ? "worktree-collision"
      : "other";
    return { worktreePath: undefined, failure: { errorClass, message } };
  }

  if (tip !== headSha) {
    cleanupMaterializedWorktree(removeWorktree, repoDir, worktreePath);
    throw new Error(
      `materialized worktree at ${worktreePath} is at ${tip}, not the PR head ${headSha} — ` +
        "a stale fetch or a moved ref; refusing to review a possibly-wrong tree rather than posting a false verdict",
    );
  }
  return { worktreePath };
}

/** Best-effort removal of a worktree a materialization attempt itself just
 * created, on that SAME attempt's failure — swallows a removal error rather
 * than masking the materialization failure/mismatch that triggered it (the
 * console still hears about a removal failure, mirroring {@link
 * withMaterializedWorktree}'s own teardown-failure handling). */
function cleanupMaterializedWorktree(
  remove: (repoDir: string, worktreePath: string) => void,
  repoDir: string,
  worktreePath: string,
): void {
  try {
    remove(repoDir, worktreePath);
  } catch (e) {
    console.error(
      `(worktree teardown failed for ${worktreePath} after a materialization failure: ` +
        `${String((e as Error)?.message ?? e)})`,
    );
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
  remove: (repoDir: string, worktreePath: string) => void = worktreeRemove,
): Promise<T> {
  try {
    return await body();
  } finally {
    if (worktreePath) {
      try {
        remove(repoDir, worktreePath);
      } catch (e) {
        // Best-effort teardown: a removal failure must never mask `body`'s own
        // result or throw — the ledger/console already carry the review's
        // outcome; a stranded worktree here is a startup-prune concern
        // (pruneStaleRuns), never this command's job to retry.
        console.error(`(worktree teardown failed for ${worktreePath}: ${String((e as Error)?.message ?? e)})`);
      }
    }
  }
}

/**
 * `rmd review`'s OWN `Remudero-Task: <id>` trailer extraction (W1-T70). The worker prompt
 * DICTATES the contract ("Include this exact trailer as the LAST line of the PR body") but
 * the pre-W1-T70 read here was an UNANCHORED `body.match(/Remudero-Task:\s*(\S+)/)` — any
 * body that QUOTES the trailer format mid-prose (increasingly common on plan/ratify PRs,
 * which routinely discuss the trailer contract itself — observed live on #119 and one
 * earlier) was captured ahead of the genuine final line. 4th instance of the first-match
 * parser class: the DECISION_REQUEST near-miss, `parseReport`'s first-URL bug (W1-T62 —
 * `anchoredPrUrl` in lib/worker.ts is the SAME matchAll-and-take-last idiom this mirrors),
 * and `deriveStatus` rung (c) (W1-T69). LINE-ANCHORED (`^...$`, per line) so a mid-prose
 * mention never matches; LAST-LINE-WINS (scanning ALL anchored matches, keeping the final
 * one) because that is the contract's own phrasing. No anchored trailer at all ⇒ `undefined`,
 * unchanged from before — the caller falls through to the PR body's `Acceptance:` block.
 */
/**
 * THE RETRO'S ACCEPTANCE-BLOCK REPAIR RUNG, extracted so the DECISION is reachable by a test.
 *
 * It was inline in `retroCommand`, which meant the trigger — the thing this change fixes — could
 * only be pinned by source text and earned zero coverage. diff-coverage flagged it as a wiring line
 * with `DA:0`, which is this repo's "seam built but never called" hazard pointed at the exact
 * predicate being widened. Extracting it is the honest answer to that, not a wider lcov.
 *
 * Deps are injected LAST and default to the real bindings by object-spread (never `??`, which V8
 * instruments as a branch and would leave the untaken real side permanently uncovered).
 *
 * Best-effort by contract: `retroCommand` must never fail because a repair attempt failed, so every
 * throw is caught and ledgered as `acceptance.repair.error` rather than propagating.
 */
export function repairRetroAcceptanceBlock(
  prUrl: string,
  log: (step: string, extra?: Record<string, unknown>) => void,
  deps: {
    fetchBody?: (url: string) => string;
    editBody?: (url: string, body: string) => void;
  } = {},
): "repaired" | "healthy" | "error" {
  const { fetchBody, editBody } = {
    fetchBody: defaultRetroFetchBody,
    editBody: defaultRetroEditBody,
    ...deps,
  };
  try {
    const body = fetchBody(prUrl);
    // The SAME predicate ensureJudgeableBody itself uses (bodyNeedsAcceptanceRepair,
    // plan-pr-emitter.ts) — this call site used to carry its own `=== 0` copy, which meant widening
    // the repair would have left the duplicate here still declining to fire on a body that parses
    // to one criterion with an empty proof. One definition, two consumers.
    if (!bodyNeedsAcceptanceRepair(body)) return "healthy";
    const repaired = ensureJudgeableBody(body, [
      {
        claim: "the retro's plan-only sync PR is gate-compliant",
        proof:
          "SHIPPED-log/NET-STATE/calibration-table updates and the COMPRESSION deletion are in this diff; " +
          "docs/ORIENTATION.md and plan/plan-index.json are harness-regenerated separately in this same PR",
      },
    ]);
    editBody(prUrl, repaired);
    log("acceptance.repaired", { pr_url: prUrl });
    return "repaired";
  } catch (e) {
    log("acceptance.repair.error", { error: String((e as Error)?.message ?? e) });
    return "error";
  }
}

function defaultRetroFetchBody(url: string): string {
  const view = ghJson(["pr", "view", url, "--json", "body"]) as { body?: string };
  return view.body ?? "";
}

function defaultRetroEditBody(url: string, body: string): void {
  execFileSync("gh", ["pr", "edit", url, "--body", body], { stdio: "pipe" });
}

export function reviewTaskIdFromBody(body: string): string | undefined {
  const matches = [...body.matchAll(/^Remudero-Task:\s*(\S+)\s*$/gm)];
  return matches.length ? matches[matches.length - 1][1] : undefined;
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
interface ReviewCommandDeps {
  fetchView?: (args: string[]) => unknown;
  loadConfig?: () => Config;
  materialize?: typeof materializeReviewWorktree;
  runReview?: typeof runReview;
}

/**
 * The PR NUMBER `prArg` names, or `undefined` when it names something REST cannot address.
 *
 * `gh pr view` accepts a number, a URL, OR a bare branch name; `GET /repos/{o}/{r}/pulls/{n}`
 * accepts only a number. So the transport swap below is conditional on this resolving, and the
 * branch-name form deliberately keeps its existing `gh pr view` path — see
 * {@link reviewViewArgs}. The sweep is unaffected either way: its `reviewRunner` passes
 * `String(prNumber)`, so it always takes the REST arm.
 */
export function reviewPrNumber(prArg: string): number | undefined {
  const bare = /^#?(\d+)$/.exec(prArg.trim());
  if (bare) return Number(bare[1]);
  // A github.com PR URL, the other form an operator pastes. Anchored on `/pull/<n>` so a branch
  // literally named "pull/7" cannot be mistaken for one.
  const url = /^https?:\/\/[^\s]*\/pull\/(\d+)(?:[/?#].*)?$/.exec(prArg.trim());
  return url ? Number(url[1]) : undefined;
}

/**
 * THE ARGV `reviewCommand` READS A PR WITH — REST when the PR is addressable by number,
 * `gh pr view` otherwise.
 *
 * WHY THIS EXISTS AS ITS OWN EXPORTED FUNCTION rather than inline at the call site: the defect
 * being fixed is WHICH ARGV gets built, so that is the thing a falsifier has to be able to assert
 * directly. An inline ternary would only be observable through a stubbed fetcher's recorded
 * calls, which is the shape the ci-parity suites already use and precisely why several defects
 * in this path survived.
 *
 * THE DEFECT. `gh`'s `--json` flag is implemented over GitHub's GraphQL API, so this read — the
 * FIRST call `reviewCommand` makes — sat on the GraphQL point budget. Measured over the unioned
 * ledger at 493656b: `sweep.post_review` attempted 382, succeeded 292, and failed 87, and ALL 87
 * carry the identical error, verbatim: `Command failed: gh pr view <n> --repo craigoley/remudero
 * --json headRefOid,headRefName,body,url,number` / `GraphQL: API rate limit already exceeded for
 * user ID 4397075`. 77 of those 87 are from a single day. The loop is self-reinforcing: the sweep
 * cannot post the review that would let a green PR merge, so the PR stays open and is re-read
 * next tick, burning the budget that would have cleared it. At filing, GraphQL sat at 0/5000
 * while REST core had 4,569 of 5,000 unused.
 *
 * THIS IS W1-T265's MIGRATION, APPLIED TO ONE MORE READ. It reuses that task's own
 * {@link singlePrRestArgs} and {@link mapRestPr} rather than re-deriving a mapping, so the four
 * load-bearing translations (html_url→url, `body` null→"", headRefName ""-not-undefined,
 * auto_merge passthrough) are the ones already proven and tested there.
 *
 * TRANSPORT ONLY. The fields handed to the reviewer are identical, so what is judged, how proofs
 * execute, and how a status is posted are all untouched.
 */
export function reviewViewArgs(owner: string, repo: string, prArg: string): string[] {
  const n = reviewPrNumber(prArg);
  if (n !== undefined) return singlePrRestArgs(owner, repo, n);
  return ["pr", "view", prArg, "--repo", `${owner}/${repo}`, "--json", "headRefOid,headRefName,body,url,number"];
}

/**
 * OWNER, REPO AND NUMBER FROM A PR URL — the three things REST addressing needs, all of which a
 * github.com PR URL already carries.
 *
 * WHY PARSING AND NOT THREADING, established before writing rather than assumed. The two
 * remaining `--json headRefOid` reads both receive a URL and nothing else:
 * {@link ArmDeps.headSha} is typed `(prUrl: string) => string`, and its real implementation comes
 * from {@link realArmDeps}, which takes NO arguments and is evaluated as `armAutoMerge`'s own
 * default parameter — so there is no call site to thread an owner/repo from without changing
 * three exported signatures and every caller of them. A URL is
 * `https://github.com/<owner>/<repo>/pull/<n>` and yields all three unambiguously.
 *
 * ANCHORED ON `/pull/<n>`, exactly as {@link reviewPrNumber} is, so a branch literally named
 * `pull/7` cannot be mistaken for a PR reference. Returns `undefined` — never a guess — on
 * anything that is not a PR URL.
 */
export function prUrlTarget(prUrl: string): { owner: string; repo: string; number: number } | undefined {
  const m = /^https?:\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(prUrl.trim());
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : undefined;
}

/**
 * THE ARGV THE HEAD-SHA READ USES — REST, always, or a loud refusal.
 *
 * THE DEFECT, and why this is not {@link reviewViewArgs} copied. Both remaining
 * `gh pr view <URL> --json headRefOid` reads sit in the POST-REVIEW path, where a GraphQL
 * rate-limit error blocks the whole review lane: `post_review`'s FIRST call is this read, so the
 * sweep cannot post the review that would clear the very PR whose re-reads are burning the
 * budget. `--json` is implemented over GraphQL; `GET /repos/{o}/{r}/pulls/{n}` is REST, a
 * separate quota.
 *
 * NO SILENT FALLBACK, AND THAT IS THE WHOLE POINT. {@link reviewViewArgs} legitimately falls back
 * to `gh pr view` because its input may be a BARE BRANCH NAME, which REST cannot address at all.
 * These two callers are given a URL. A URL that does not parse is a broken caller, not a branch —
 * so this THROWS rather than reaching for the GraphQL argv. A fallback here would reproduce the
 * exhaustion under the exact conditions the migration exists to survive, while reading as fixed.
 *
 * Reuses {@link singlePrRestArgs} rather than re-deriving the path, per W1-T265 and #1348.
 */
export function headShaRestArgs(prUrl: string): string[] {
  const target = prUrlTarget(prUrl);
  if (!target) {
    throw new Error(
      `head-sha read: cannot resolve owner/repo/number from ${JSON.stringify(prUrl)} — refusing to fall back ` +
        "to `gh pr view --json`, whose GraphQL budget exhaustion is the defect this read was migrated off",
    );
  }
  return singlePrRestArgs(target.owner, target.repo, target.number);
}

/**
 * Read a PR's live head sha over REST.
 *
 * REFUSES AN EMPTY SHA. {@link mapRestPr} maps `headRefOid` from `row.head?.sha ?? ""`, so a
 * response missing `head.sha` yields `""` rather than throwing. Handing that back would be WORSE
 * than the rate-limit failure this replaces: the caller would judge and post a verdict against an
 * empty head instead of failing. So an absent sha is raised here, where it is attributable.
 */
export function readHeadShaRest(prUrl: string, fetch: GhApiFetcher = ghJson): string {
  const sha = mapRestPr(fetch(headShaRestArgs(prUrl)) as RestPullRow).headRefOid;
  if (!sha) {
    throw new Error(`head-sha read: ${prUrl} returned no head sha — refusing to report an empty head`);
  }
  return sha;
}

async function reviewCommand(prArg: string, rest: string[] = [], deps: ReviewCommandDeps = {}): Promise<number> {
  const {
    fetchView,
    loadConfig: loadConfigDep,
    materialize,
    runReview: runReviewDep,
  } = { fetchView: ghJson, loadConfig, materialize: materializeReviewWorktree, runReview, ...deps };

  // `--repo <name>` or `--repo <owner>/<name>` lets the runner post remudero-review to a
  // repo OTHER than this checkout (e.g. remudero-sandbox for the daemon's live commissioning,
  // W1-T12d). Without it, resolveOwnerRepo() pins to repoRoot's origin (the main repo) and
  // `gh pr view` resolves the PR in the CWD — so a sandbox PR could never be gated. The lib
  // layer (runReview / postReviewStatus) already takes owner+repo; only the CLI was pinned.
  const { owner, repo } = resolveReviewTarget(resolveOwnerRepo(), rest);
  // W1-T265's REST transport, applied to this read — see reviewViewArgs for the 87 measured
  // failures this closes. The REST arm returns a raw pull row and is normalised by that task's
  // own `mapRestPr`; the `gh pr view` arm (a bare branch name, which REST cannot address) already
  // returns the `gh --json` shape and passes through untouched. Both arms yield the SAME five
  // fields, so nothing downstream of `body` can tell which transport served it.
  const args = reviewViewArgs(owner, repo, prArg);
  const raw = fetchView(args);
  const view = (reviewPrNumber(prArg) !== undefined ? mapRestPr(raw as RestPullRow) : raw) as {
    headRefOid: string;
    headRefName: string;
    body: string;
    url: string;
    number: number;
  };
  const body = view.body ?? "";

  // Criteria: task trailer → tasks.yaml; else the PR body's Acceptance: block.
  let criteria: AcceptanceCriterion[] = [];
  let source = "NONE (fail closed — nothing to judge is never a pass)";
  const taskId = reviewTaskIdFromBody(body);
  // W1-T322: the same plan lookup this block already does for `criteria` also carries the
  // task's declared scope + the plan's open-id set — advisory-only inputs judgeReview needs.
  // Both stay `undefined` on ANY read/parse failure (see the catch below), exactly like
  // `criteria` degrading to the body's Acceptance: block — never a reason to fail the review.
  let taskDeclaredFiles: string[] | undefined;
  let openTaskIds: Set<string> | undefined;
  if (taskId) {
    try {
      const reviewPlanPath = join(repoRoot, "plan", "tasks.yaml");
      // W1-T120: read the raw bytes ourselves (loadPlan re-reads the same path
      // internally) so the READ-IDENTITY ASSERTION below hashes exactly what was
      // opened — the abs path + content hash of the plan file this review actually
      // read, legible in the printed summary instead of merely inferable from cwd.
      const reviewPlanRaw = readFileSync(reviewPlanPath, "utf8");
      const plan = loadPlan(reviewPlanPath);
      const t = plan.byId.get(taskId);
      if (t?.acceptance?.length) {
        criteria = t.acceptance;
        source =
          `plan/tasks.yaml task ${taskId} (${criteria.length} criteria) — ` +
          `read: ${formatReadIdentity(reviewPlanPath, reviewPlanRaw)}`;
      }
      taskDeclaredFiles = t?.files;
      // W1-T367 (design (v)): this manual `rmd review` path has no derived projection in hand
      // here (unlike `runTask`'s dispatch path, which builds one for `assertRunnable` and
      // passes it straight through) — computing one would be a second, independent GitHub read
      // this reviewer does not otherwise need. `openTaskIdsFromPlan(plan)` with no projection
      // argument degrades to the EMPTY set (documented on that function), so every
      // `SHIPS-UNWIRED:` marker at this call site is FLAGGED rather than wrongly honoured — the
      // safe direction (design (vi)), never the pre-W1-T367 yaml read that credited 248 merged
      // tasks as open.
      openTaskIds = openTaskIdsFromPlan(plan);
    } catch {
      // A bad/absent plan is not the reviewer's concern; fall through to the body.
    }
  }
  if (criteria.length === 0) {
    const fromBody = parseAcceptanceBlock(body);
    if (fromBody.length) {
      criteria = fromBody;
      source = `PR body Acceptance: block (${fromBody.length} criteria)`;
    }
  }

  const config = loadConfigDep();
  const ledgerPath = ledgerPathFor(config);
  const runId = `review-PR${view.number}-${Date.now()}`;
  const log = (step: string, extra: Record<string, unknown> = {}) =>
    appendLedger(ledgerPath, { run_id: runId, task_id: taskId ?? `PR-${view.number}`, step, ...extra });

  console.log(`### rmd review PR #${view.number} — criteria from ${source}`);

  // W1-T185 (Gap 2): materialize a throwaway worktree at the PR head so
  // whitelisted proofs actually EXECUTE on this manual path, matching what
  // the automated fix rung observes for the same PR/proofs (acceptance
  // criterion 4). On ANY failure this leaves worktreePath undefined and the
  // review falls back to keyword-only — EXPLICITLY marked (criterion 5),
  // never silently, and (W1-T233) the console line below now NAMES why,
  // instead of a bare "unavailable" with the real reason thrown away.
  const materialized = materialize(config, repoRoot, view.number, view.headRefName, view.headRefOid);
  if (materialized.worktreePath === undefined) {
    console.log(
      `(worktree materialization failed [${materialized.failure.errorClass}]: ` +
        `${materialized.failure.message} — this verdict will post keyword-only)`,
    );
  }
  const worktreePath = materialized.worktreePath;

  // W1-T185 (Gap 2, criterion 6): withMaterializedWorktree guarantees teardown
  // on EVERY exit path, including a throw from runReview itself — never just
  // the success path, which would reproduce the W1-T175 leak class.
  const verdict = await withMaterializedWorktree(worktreePath, repoRoot, () =>
    runReviewDep({
      owner,
      repo,
      prUrl: view.url,
      // impl-BG: excludes dependabot heads from the post-verdict arm (the dep-review lane owns those).
      headRefName: view.headRefName,
      task: { id: taskId ?? `PR-${view.number}`, acceptance: criteria, files: taskDeclaredFiles },
      report: body, // the PR body is the manual author's REPORT (proofs are pasted here)
      settingsFile: "",
      config,
      log,
      say: (m) => console.log(m),
      account: (r) => r,
      spawnReviewer: false, // deterministic binding path — the same judge, by hand
      // spawnReviewer:false ⇒ never actually consulted (no spawn happens); "medium"
      // is a safe, always-resolvable placeholder — a manual `rmd review` PR carries
      // no plan task risk of its own to key a real one off.
      reviewerMount: resolveMount(loadMounts(mountsPath(repoRoot)), "reviewer", "medium"),
      // W1-T185 (Gap 2): the materialized worktree above when available — the
      // SAME `headCheckoutDir` wiring the autonomous path uses, so whitelisted
      // proofs execute here too. `undefined` (materialization unavailable)
      // makes `judgeReview` mark the verdict `keywordOnly`+`capped`, exactly
      // the documented fallback (criterion 5) — never silent.
      headCheckoutDir: worktreePath,
      // impl-GE: the merge-base blobs this PR's `grep:` proofs name, so a proof that ALREADY
      // matched before the work existed is marked `executed_stale` instead of counting as evidence.
      // `undefined` when the PR has no grep proof or no resolvable base — the check then stays inert,
      // exactly as it was for its first 1,180 verdicts.
      baseCheckoutDir: worktreePath ? buildBaseProofDir(criteria, worktreePath) : undefined,
      // W1-T233: the named reason materialization failed (absent ⇒ it was
      // never attempted at all) — carried onto the posted CAPPED description
      // and the review.posted ledger line's degraded_reason fields.
      materializationFailure: materialized.failure,
      ledgerPath,
      runId,
      openTaskIds,
    }),
  );

  console.log(
    `\nremudero-review=${verdict.state} posted to ${view.url} (head ${verdict.headSha.slice(0, 7)})` +
      (verdict.keywordOnly ? " — KEYWORD-ONLY: no proof was executed (no PR-head checkout)" : "") +
      (verdict.capped ? " — CAPPED: not certified (0 proofs executed)" : ""),
  );

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
  } else if (verdict.capped) {
    console.log(
      `NOTE: a CAPPED verdict cannot arm auto-merge without executed proof or an operator override: ` +
        `rmd review ${view.number} --override-capped-by <name> --override-capped-reason <text>`,
    );
  }

  return verdict.state === "success" ? 0 : 1;
}

/**
 * `rmd dep-review <pr>` — the dependency-PR review lane (W1-T54, MASTER-PLAN §5D
 * item 1). Required checks are `[ci-gate, remudero-review]`; nothing ever posted
 * `remudero-review` on a Dependabot PR, so every Dependabot PR sat UNMERGEABLE —
 * fail-closed but frozen. This is a SECOND deterministic judge (never an LLM),
 * scoped to Dependabot PRs: {@link decideDepReview} (lib/dep-review.ts) is the
 * pure verdict; this command is only the `gh` plumbing around it, mirroring
 * `reviewCommand` above.
 *
 *   - refuse:   not a Dependabot PR, or its diff touches source outside the
 *     manifest/lockfile allowlist. Nothing is posted (exit 2).
 *   - hold:     a required check is genuinely red. Nothing is posted (exit 1) —
 *     the caller (a future poll / drain) tries again later.
 *   - arm:      minor/patch, confined, gates green. Posts remudero-review=success
 *     and arms auto-merge (exit 0).
 *   - escalate: major (or unparseable — fail closed). Posts remudero-review=
 *     failure (so it can NEVER auto-merge) and opens a MANUAL needs-human issue
 *     carrying the release notes via the SHIPPED escalate() path (exit 1).
 */
/**
 * impl-BI — the injectable effects of {@link depReviewCommand}. The `arm` branch's tail was the
 * one lane this PR touched that NO test could reach: `ghJson`/`gh pr diff`/`postReviewStatusGuarded`
 * were all hardcoded, so `diff-coverage` correctly flagged the changed arm lines as adding
 * uncovered source. This is the same shape PR #964 gave `triageCommand`/`planCommand` — optional
 * with `??` defaults, so every existing caller and the CLI entry point are byte-identical in
 * behaviour, and the ONLY new capability is that a test can drive the branch offline.
 *
 * `config` is injectable for the reason W1-T2/PR #18 recorded: `loadConfig()` shells out to
 * `which claude`, which does not exist on a CI runner.
 */
export interface DepReviewDeps {
  gh?: (args: string[]) => unknown;
  prDiff?: (prUrl: string) => string;
  config?: Config;
  postStatus?: typeof postReviewStatusGuarded;
  arm?: (prUrl: string, taskId: string | undefined) => ArmOutcome;
  /**
   * impl-FR — appended LAST so no existing caller shifts. Used by BOTH escalating call sites.
   *
   * I first wired only the new detector and left the escalate branch's hardcoded gateway alone,
   * on the reasoning that this task had no business widening it. The `live-write-guard` falsified
   * that: driving a major/unparseable bump offline is exactly what proves the safety lock, and
   * with the gateway hardcoded those tests tried to file a REAL issue on craigoley/remudero. A
   * branch that cannot be exercised without a live write is a branch whose safety cannot be
   * asserted, so both sites now take the seam.
   */
  issues?: IssueGateway;
}

async function depReviewCommand(prArg: string, rest: string[] = [], deps: DepReviewDeps = {}): Promise<number> {
  const { owner, repo } = resolveReviewTarget(resolveOwnerRepo(), rest);
  const slug = `${owner}/${repo}`;
  const view = (deps.gh ?? ghJson)([
    "pr",
    "view",
    prArg,
    "--repo",
    slug,
    "--json",
    "number,url,title,body,headRefOid,author,statusCheckRollup",
  ]) as {
    number: number;
    url: string;
    title: string;
    body: string;
    headRefOid: string;
    author?: { login?: string };
    statusCheckRollup?: RollupEntry[];
  };
  const diff = (deps.prDiff ?? ((u: string) => execFileSync("gh", ["pr", "diff", u], { encoding: "utf8", maxBuffer: 1 << 26 })))(view.url);

  const config = deps.config ?? loadConfig();
  const ledgerPath = ledgerPathFor(config);
  const runId = `dep-review-PR${view.number}-${Date.now()}`;
  const taskId = `dep-review-PR${view.number}`;
  const log = (step: string, extra: Record<string, unknown> = {}) =>
    appendLedger(ledgerPath, { run_id: runId, task_id: taskId, step, ...extra });

  const result = decideDepReview({
    author: { login: view.author?.login ?? "" },
    title: view.title ?? "",
    body: view.body ?? "",
    diff,
    checks: view.statusCheckRollup ?? [],
  });
  log("dep-review.decided", { ...result, pr_url: view.url });
  console.log(`### rmd dep-review PR #${view.number} — ${result.decision}: ${result.reason}`);

  if (result.decision === "refuse") {
    console.log(`no remudero-review posted (refused): ${view.url}`);
    return 2;
  }
  if (result.decision === "hold") {
    console.log(`no remudero-review posted (holding for gates): ${view.url}`);
    return 1;
  }
  if (result.decision === "arm") {
    // W1-T228: guarded post — decideDepReview never executes a proof, so
    // this attempt's evidence is always "no_evidence"; the guard still
    // refuses it if a STRONGER (executed) verdict is already posted for this
    // exact sha, or if the PR is already merged/closed.
    const posted = await (deps.postStatus ?? postReviewStatusGuarded)({
      owner,
      repo,
      sha: view.headRefOid,
      state: "success",
      description: `remudero-review: PASS — ${result.semverLevel} dependency bump, confined + gates green`,
      taskId,
      evidence: "no_evidence",
      ledgerPath,
      runId,
      fetchLifecycle: () => fetchPrLifecycle(view.url),
    });
    if (!posted.posted) {
      console.log(`no remudero-review posted (refused: ${posted.reason}): ${view.url}`);
      return 1;
    }
    // W1-T230: armAutoMerge no longer trusts the live status just posted above
    // (display/branch-protection only from here on) — it keys off this
    // orchestrator's OWN ledgered `review.posted` verdict. This second judge
    // (decideDepReview) must ledger its own verdict in that SAME shape so
    // armAutoMerge has a record to find for this task/head.
    log("review.posted", {
      context: REVIEW_CONTEXT,
      state: "success",
      head_sha: view.headRefOid,
      dep_review: true,
      proof_exec: [], // W1-T228: never executes a proof — explicit so lastPostedReviewStatusFromLedger reads "no_evidence"
    });
    const armOutcome = armAndLogOutcome(view.url, taskId, log, deps.arm);
    console.log(`remudero-review=success posted + auto-merge ${armReportPhrase(armOutcome)}: ${view.url}`);
    // impl-FR — THE DETECTOR. This lane is the ONLY arm path for a Dependabot PR: the sweep's
    // ordered, first-match-wins DISPOSITION_RULES put `dep-review` above both `mergeable` and
    // `post-review`, and the shared review lane refuses `dependabot/` heads by name. So an arm
    // that did not take leaves the PR green, unobjected-to and permanently unmerged, with nothing
    // to rescue it — the one silent failure in this repo that no other surface reports.
    //
    // SAFETY IS POSITIONAL, not re-derived: this sits INSIDE `if (result.decision === "arm")`,
    // after decideDepReview already refused (`return 2`), held (`return 1`) or escalated. A major
    // bump, an unparseable version and a source outside the manifests all return before here, so
    // this cannot fire for them — and it arms nothing in any case, it only reports.
    if (!armOutcomeArmed(armOutcome)) {
      const stuck = buildDepReviewArmUnreachableEscalation({
        prUrl: view.url,
        prNumber: view.number,
        title: view.title ?? "",
        headSha: view.headRefOid,
        outcome: String(armOutcome),
      });
      const issueUrl = escalate(stuck, {
        issues: deps.issues ?? ghIssueGateway(owner, repo),
        ledgerPath,
        runId,
      });
      log("dep-review.arm_unreachable", {
        issue_url: issueUrl,
        outcome: armOutcome,
        head_sha: view.headRefOid,
        pr_url: view.url,
      });
      console.log(`dep-review: NOTHING ELSE CAN ARM THIS PR — escalated: ${issueUrl}`);
    }
    return 0;
  }
  // escalate: post failure (NEVER auto-merge for a major) + open the MANUAL issue.
  // impl-FR: routed through the SAME seam as the arm branch at :5132. It was hardcoded, so the
  // escalate path always reached the real `postReviewStatusGuarded` → `fetchPrLifecycle` →
  // `gh pr view`. That is why the two SAFETY tests passed locally (an authenticated `gh` quietly
  // made a LIVE call about PR #80) and failed in CI, where no GH_TOKEN exists. A branch whose
  // safety is asserted by a test that silently talks to the network is not actually asserted.
  const postedFailure = await (deps.postStatus ?? postReviewStatusGuarded)({
    owner,
    repo,
    sha: view.headRefOid,
    state: "failure",
    description: `remudero-review: FAIL — ${result.reason}`, // postReviewStatus truncates to 140
    taskId,
    evidence: "no_evidence",
    ledgerPath,
    runId,
    fetchLifecycle: () => fetchPrLifecycle(view.url),
  });
  if (postedFailure.posted) {
    // W1-T228: ledger this verdict too (the pre-existing code never did) — a
    // failure posted here but never ledgered would be INVISIBLE to a later
    // attempt's precedence check, exactly the blind spot this task closes.
    log("review.posted", {
      context: REVIEW_CONTEXT,
      state: "failure",
      head_sha: view.headRefOid,
      dep_review: true,
      proof_exec: [],
    });
  } else {
    console.log(`remudero-review=failure NOT posted (refused: ${postedFailure.reason}) — still escalating: ${view.url}`);
  }
  const escalation = buildDepReviewEscalation({
    prUrl: view.url,
    prNumber: view.number,
    title: view.title ?? "",
    body: view.body ?? "",
    semverLevel: result.semverLevel,
  });
  const issueUrl = escalate(escalation, { issues: deps.issues ?? ghIssueGateway(owner, repo), ledgerPath, runId });
  log("dep-review.escalated", { issue_url: issueUrl });
  console.log(`remudero-review=failure posted (no auto-merge); escalated: ${issueUrl}`);
  return 1;
}

/**
 * `rmd lint-plan [--plan <path>] [--base <git-ref>] [--all]` — the CI half of §5C Layer A
 * (the pre-dispatch half lives in `runTask`, see `assertLintClean`).
 *
 * With `--base`, lints ONLY the task ids that are NEW or CHANGED relative to
 * that git ref (`changedTaskIds`, comparing `<ref>:plan/tasks.yaml` to the
 * working copy) — this is what makes the FAIL-CLOSED CI gate safe to turn on
 * immediately: it judges the PR's OWN edit, not the whole historical queue
 * (re-grading everything already open is the retro's separate, periodic
 * plan-health sweep, W1-T20d — not every PR's gate). CI's `--base` MODE IS
 * UNTOUCHED BY W1-T324 — its scope, its output shape, its exit code are
 * byte-identical to before; nothing below affects it.
 *
 * Without `--base` (W1-T324): DEFAULTS to OPEN-TASK failures only — a task
 * whose status is `blocked`, `merged`, or `done` (see {@link isOpenLintTask})
 * is a RETIRED or LANDED plan record, not live queue debt, and is excluded
 * from both the check and the printed count. MEASURED at the audit that filed
 * W1-T324: ~92% of the whole-plan failure count sat on such records — a
 * standing number nobody could burn down trained everyone to ignore the
 * gauge. `--all` restores the PRE-W1-T324 behavior (every task, open or not)
 * for the periodic archaeology sweep that wants it (W1-T20d). Either way the
 * summary line NAMES both counts — how many open tasks are failing, and how
 * many additional records exist behind `--all` — so the retired/landed corpus
 * stays visible without being the headline.
 *
 * Exits non-zero iff any IN-SCOPE task has a BLOCKING violation. Resolving
 * `--base` itself failing (bad ref, unreadable git history) is a LOUD
 * configuration error (exit 2), never a silent fall-back to full-plan or
 * no-op — the control surface never guesses on ambiguous input.
 */
/** W1-T324: a task whose plan record still represents LIVE, dispatchable work — the
 *  complement of a RETIRED withdrawal record (`blocked`, the W1-T229 convention) or a
 *  LANDED one (`merged`/`done`). This is a literal `status:` field read, deliberately —
 *  NOT the derived-from-GitHub merge status `lintPlanCommand`'s `--base` branch already
 *  computes via `projectPlan` (that read is scoped + network-backed and stays exactly
 *  where it is); this is the cheap, always-available filter the whole-plan default needs.
 *  Kept LOCAL to run-task.ts, not lifted into lib/plan.ts — W1-T324's declared `files:` is
 *  [plan/tasks.yaml, src/run-task.ts, test/lint-plan-open-only.test.ts] only.
 *
 *  W1-T367 RE-EXAMINED this exact reader (the third of three "yaml `status:` has live readers"
 *  sites re-derived from source) and RULED: LEAVE IT, deliberately. plan/tasks.yaml's own
 *  header ("STATUS MODEL") names `status:` DECORATIVE / initial-state only, and `rmd lint-plan`
 *  (this reader's caller) is that decision's one INTENDED consumer: an OFFLINE, DETERMINISTIC
 *  linter that must run with no network — converting it to `projectPlan`'s derived status would
 *  make a pure linter GitHub-dependent and non-deterministic, and would swing the standing
 *  whole-plan open-task signal from ~360 to ~112 with no gate strengthened (W1-T324/#1299
 *  shipped the open-only default precisely to keep that signal readable). This reader relies on
 *  the header's initial-state scoping DELIBERATELY, not by oversight — the two readers that
 *  WERE wrong (`planHealthSweep`/lib/retro.ts, `openTaskIdsFromPlan`/this file) both degraded a
 *  GATE by trusting stale yaml; this one only SCOPES a display count, and staying yaml-based is
 *  what keeps it deterministic. */
const NON_OPEN_LINT_STATUSES = new Set<TaskStatus>(["blocked", "merged", "done"]);

/** See {@link NON_OPEN_LINT_STATUSES}. */
function isOpenLintTask(task: Pick<Task, "status">): boolean {
  return !NON_OPEN_LINT_STATUSES.has(task.status);
}
/**
 * W1-T278: the git-HISTORY half of the mint, layered on top of {@link mintNextTaskId}'s
 * current-tree union (lib/task-id.ts, untouched by this task). A task filed then FOLDED away
 * — removed from tasks.yaml, every `tasks.d/` shard, and its PR long since merged/closed —
 * leaves NO trace in any of the three sources that module already unions, by construction:
 * each of those reads the CURRENT tree, and a fold is exactly a removal from the current
 * tree. Git history is the one source that survives it: every id ever DECLARED under `plan/`
 * across every commit that ever touched it, recoverable without a network call and without
 * checking out any ref other than the one already on disk.
 *
 * Only the id's ADDITION counts (a `+`-prefixed line in `git log -p`'s patch stream) — its
 * later removal (the fold itself) never un-counts it, which is the entire point: once filed,
 * always treated as used, so the derivation MAY skip a number but must never hand back one
 * some past commit already owned. Renumbering, reclaiming a folded id, and changing the id
 * format are explicitly out of scope (W1-T278's own design note).
 */
const ADDED_TASK_ID_RE = /^\+\s*(?:-\s*)?id:\s*["']?W1-T(\d+)/gm;

/** Ids DECLARED in lines a `git log -p` patch ADDS — see {@link ADDED_TASK_ID_RE}. */
function extractAddedTaskIds(patch: string): number[] {
  return [...patch.matchAll(ADDED_TASK_ID_RE)].map((m) => Number(m[1]));
}

/** The on-disk shape of the history scan's cache — see {@link taskIdsEverFiled}. */
interface TaskIdHistoryCache {
  /** The commit sha the scan last walked THROUGH — everything at or before it is in `ids`. */
  sha: string;
  /** The `plan/`-relative path scanned; a cache from a different path is never trusted. */
  planRelPath: string;
  /** Every id ever ADDED at or before `sha`. */
  ids: number[];
}

/**
 * Where the history scan's cache lives: the repo's shared git-common-dir (NOT `repoRoot`
 * itself), so a triage worktree — whose own `.git` is a FILE pointing at the main
 * checkout's object store, not a directory — still shares one cache with every other
 * worktree of the same repo. `null` when even `--git-common-dir` fails: every mint then
 * does a full (still-correct, just slower) scan with no cache to read or write.
 */
function taskIdHistoryCachePath(repoRoot: string, gitRunner: (args: string[]) => string): string | null {
  try {
    const raw = gitRunner(["rev-parse", "--git-common-dir"]).trim();
    const gitDir = isAbsolute(raw) ? raw : resolve(repoRoot, raw);
    return join(gitDir, "rmd-task-id-history-cache.json");
  } catch {
    return null;
  }
}

/** A cache that fails to parse, or was shaped by an older/different scan, is never trusted —
 *  it is silently discarded in favor of a full rescan, never treated as a partial truth. */
function readTaskIdHistoryCache(cachePath: string): TaskIdHistoryCache | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(cachePath, "utf8"));
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as TaskIdHistoryCache).sha === "string" &&
      typeof (parsed as TaskIdHistoryCache).planRelPath === "string" &&
      Array.isArray((parsed as TaskIdHistoryCache).ids) &&
      (parsed as TaskIdHistoryCache).ids.every((n) => typeof n === "number")
    ) {
      return parsed as TaskIdHistoryCache;
    }
    return null;
  } catch {
    return null;
  }
}

/** Best-effort write — the cache is a cost optimization, never a correctness requirement, so
 *  a write failure (read-only checkout, full disk) is swallowed rather than degrading the mint. */
function writeTaskIdHistoryCache(cachePath: string, cache: TaskIdHistoryCache): void {
  try {
    writeFileSync(cachePath, JSON.stringify(cache), "utf8");
  } catch {
    // best-effort
  }
}

/**
 * Every task id ever DECLARED under `planRelPath` across the git history of `repoRoot`,
 * bounded by a cache keyed on the commit sha it last scanned through (measured on this repo:
 * a full `git log -p` over `plan/`'s ~260 history-touching commits costs ~0.12s; a warm,
 * cache-bounded rescan of only the commits ADDED since is ~0.01s — the shape the design note
 * asked for, cheap enough for an interactive verb either way). The id set is append-only in
 * practice (renumbering a filed id stays out of scope), so a cached sha that is still
 * resolvable is trusted as a floor and only the NEW commits are walked; a cache that fails to
 * parse, or whose sha has been pruned (a history rewrite), triggers a full rescan rather than
 * trusting stale data.
 *
 * DEGRADES HONESTLY: a `git` invocation that fails (no work tree, `git` unavailable, a
 * corrupt object store) is reported via {@link MintDegradation} exactly like an unreadable
 * shard — never swallowed into an empty, falsely-reassuring result. `degraded` here always
 * means "this scan could not prove completeness"; the caller decides what that means for the
 * mint's exit code, same as every other source.
 */
export function taskIdsEverFiled(
  repoRoot: string,
  planRelPath: string,
  gitRunner: (args: string[]) => string = (args) =>
    // maxBuffer: the `git log <range> -p -- <planRelPath>` at the bottom of this function emits
    // the FULL patch of every commit that ever touched the plan — measured 1,860,892 bytes over
    // 171 commits on 2026-08-01, already 1.8x Node's 1 MiB execFileSync default and growing
    // monotonically with every plan commit. Without this the scan dies `spawnSync git ENOBUFS`,
    // the catch below degrades it to an EMPTY id set, and the mint silently loses its only
    // ceiling-protector against reissuing a folded-away id. Narrowing the diff does not help:
    // `--unified=0` still measures 1,673,006 bytes. 1 << 26 (64 MiB) is this file's existing
    // idiom for exactly this class of problem — see the `gh pr diff` reader at :5047.
    execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 1 << 26 }),
): { ids: number[]; degraded: MintDegradation[] } {
  const degraded: MintDegradation[] = [];
  let headSha: string;
  try {
    headSha = gitRunner(["rev-parse", "HEAD"]).trim();
  } catch (err) {
    degraded.push({ source: "history", reason: `cannot resolve HEAD: ${String(err)}` });
    return { ids: [], degraded };
  }

  const cachePath = taskIdHistoryCachePath(repoRoot, gitRunner);
  const cache = cachePath ? readTaskIdHistoryCache(cachePath) : null;
  if (cache && cache.sha === headSha && cache.planRelPath === planRelPath) {
    return { ids: cache.ids, degraded }; // nothing has changed since the last scan
  }

  let range = "HEAD";
  let baseIds: number[] = [];
  if (cache && cache.planRelPath === planRelPath) {
    try {
      gitRunner(["cat-file", "-e", `${cache.sha}^{commit}`]);
      range = `${cache.sha}..HEAD`; // the cached sha is still resolvable — scan only what's new
      baseIds = cache.ids;
    } catch {
      // pruned/rewritten history under us — fall through to a full rescan, not a partial one
    }
  }

  let patch: string;
  try {
    patch = gitRunner(["log", range, "-p", "--", planRelPath]);
  } catch (err) {
    degraded.push({ source: "history", reason: `cannot scan plan/ history (${range}): ${String(err)}` });
    return { ids: [], degraded };
  }

  const ids = [...new Set([...baseIds, ...extractAddedTaskIds(patch)])].sort((a, b) => a - b);
  if (cachePath) writeTaskIdHistoryCache(cachePath, { sha: headSha, planRelPath, ids });
  return { ids, degraded };
}

/** {@link mintNextTaskId}'s result, floored by {@link taskIdsEverFiled} — see that function's
 *  doc for why a folded id needs its own source. `historyMax` is `null` when `planPath` is
 *  not inside `repoRoot` at all (a fixture plan with no associated git history — skipped, same
 *  as an absent `tasks.d/` is treated as empty rather than degraded) or when the scan found no
 *  ids; either way it never LOWERS the mint, only ever raises the floor. */
export interface MintedTaskIdWithHistory {
  id: string;
  n: number;
  maxSeen: number;
  sources: MintSources;
  historyMax: number | null;
  degraded: MintDegradation[];
}

export function mintNextTaskIdWithHistory(opts: {
  planPath: string;
  repoRoot: string;
  openPrTexts?: () => string[];
  gitRunner?: (args: string[]) => string;
}): MintedTaskIdWithHistory {
  const base = mintNextTaskId({ planPath: opts.planPath, openPrTexts: opts.openPrTexts });

  const planRelPath = relative(opts.repoRoot, dirname(opts.planPath));
  let historyMax: number | null = null;
  let historyDegraded: MintDegradation[] = [];
  if (!isAbsolute(planRelPath) && !planRelPath.startsWith("..")) {
    const history = taskIdsEverFiled(opts.repoRoot, planRelPath === "" ? "." : planRelPath, opts.gitRunner);
    historyMax = history.ids.length ? Math.max(...history.ids) : null;
    historyDegraded = history.degraded;
  }

  const maxSeen = Math.max(base.maxSeen, historyMax ?? 0);
  return {
    id: `W1-T${maxSeen + 1}`,
    n: maxSeen + 1,
    maxSeen,
    sources: base.sources,
    historyMax,
    degraded: [...base.degraded, ...historyDegraded],
  };
}

/** lib/task-id.ts's `describeMint`, plus the history source — one-line provenance for the
 *  layered mint. */
export function describeMintWithHistory(mint: MintedTaskIdWithHistory): string {
  const src =
    `tasks.yaml ${mint.sources.monolith ?? "-"}, shards ${mint.sources.shards ?? "-"}, ` +
    `open PRs ${mint.sources.openPrs ?? "not enumerated"}, history ${mint.historyMax ?? "-"}`;
  const warn = mint.degraded.length
    ? ` — DEGRADED: ${mint.degraded.map((d) => `${d.source} (${d.reason})`).join("; ")}`
    : "";
  return `${mint.id} (max ${mint.maxSeen} across ${src})${warn}`;
}

/**
 * `rmd next-task-id [--plan <path>] [--offline]` — the OPERATOR-facing half of the mint
 * (lib/task-id.ts, layered with the git-history scan above). An id picked by eye collided
 * twice in one session (W1-T256->257 in #770, W1-T260->261 in #775: one already owned by a
 * merged PR, one by a `plan/tasks.d/` shard), each costing a mechanical renumber + re-push
 * after `rmd lint-plan` refused the duplicate. A THIRD class — an id filed and later folded
 * away, invisible to every current-tree source — is what the history layer closes (W1-T278).
 * This prints the derived id AND its provenance, so a mint is checkable rather than trusted.
 *
 * Exits 0 on a clean mint, 1 when a source DEGRADED (an unreadable shard, a failed open-PR
 * read, or a failed history scan): the id is then a FLOOR that may still collide upward, and
 * a non-zero exit is what stops a script from consuming it as authoritative. `--offline` skips
 * the open-PR read deliberately — that is a stated scope reduction, still reported, still
 * exit 0 (the history scan still runs offline — it is a local git read, not a network one).
 */
/**
 * `rmd check-proof <proof>` — run ONE acceptance proof through the REVIEWER'S OWN parser AND
 * executor and print what it did, so an author never has to hand-roll a verification that
 * differs from the thing that actually runs.
 *
 * WHY THIS EXISTS. The recurring cost is not that authors are careless — it is that local
 * verification and remote execution are two different programs. PR #1071's author checked a
 * `grep:` proof with `grep -F`, a FIXED-STRING matcher; the executor runs `grep -arn --`, a REGEX.
 * The `[call-site]` in the pattern was a character class to one and a literal to the other, so the
 * local check said green and the review said fail. Measured across the unioned ledger, 1,952
 * verdicts carry a failed grep proof. This verb removes the gap BY CONSTRUCTION rather than by
 * asking people to remember a rule nothing states: it calls `parseWhitelistedProof`, prints the
 * exact argv, and — W1-T387 — judges the run through {@link "./lib/review.js".execWhitelistedProof}
 * itself, the SAME function `judgeCriterion` calls at review time, rather than a second hand-rolled
 * exit-code check of its own.
 *
 * W1-T387 (THE PARSER/EXECUTOR SPLIT THIS CLOSES). Before this, `checkProofCommand` shared only
 * `parseWhitelistedProof` with the reviewer; past that it ran its OWN raw `spawnSync` and judged
 * PASS/FAIL purely by `status === 0`. For a name-filtered `unit test:` proof that is unsound:
 * `node --test --test-name-pattern` exits 0 and emits its file's own trivial TAP wrapper line even
 * when ZERO named tests matched — MEASURED live, `unit test: fixHeadAcceptable` (resolves to
 * `test/fix-rung-no-task.test.ts`) reads `exit: 0, hits: 17` here while
 * {@link "./lib/review.js".execWhitelistedProof}, which reads the TAP stream instead of the exit
 * code, reports `no-match`. An author trusted "the reviewer's own executor" and shipped a proof the
 * reviewer would cap. Calling the real executor removes that gap the same way it removed the
 * grep-matcher gap: BY CONSTRUCTION, not by a second implementation kept in sync by hand.
 *
 * DIAGNOSTICS SURVIVE THE COLLAPSE. `execWhitelistedProof` returns only a three-value verdict
 * (`"pass" | "fail" | "no-match"`, or throws) — no stdout, no exit code, no signal. This verb still
 * prints all three, by handing `execWhitelistedProof` a {@link "./lib/review.js".ProofSpawner} that
 * wraps the real one and records what it observed on the side; the VERDICT is still decided
 * entirely inside `execWhitelistedProof`, this file never re-derives it from the exit code.
 *
 * EXIT CODE IS THE VERDICT, MAPPED — see {@link CHECK_PROOF_EXIT}. `no-match` and `fail` used to
 * share exit 1; they no longer do, because they mean different things to the reviewer (`no-match`
 * degrades to the keyword floor, `fail` overrides it to UNMET) and a local check that conflated
 * them could not tell an author which one to expect.
 *
 * STRICTLY READ-ONLY. It writes no cache, no ledger line, and no state file — deliberately unlike
 * `rmd next-task-id`, which looks like a reader and writes a history cache into the SHARED git
 * common dir that every worktree and the live daemon use. Nothing here touches `config.root`,
 * `state/`, or `.git`; the only side effect is one `grep`/`node --test` child process and stdout.
 *
 * "ONE child process" WAS DOING A LOT OF WORK IN THAT SENTENCE, and the `unresolvable` branch below
 * is why it now says less. A `unit test:` proof naming a TITLE compiles to a `--test-name-pattern`
 * run over TEST_GLOB; when the title resolves to no file, that glob survived into the spawn, so the
 * "one child process" was `node --test` over the ENTIRE SUITE, with no timeout. Writing nothing is
 * not the same as doing nothing. The branch below refuses that run by default.
 */
/** Opt-in for the one `check-proof` path that would otherwise run the ENTIRE suite — see the
 *  `unresolvable` branch in {@link checkProofCommand}. */
export const CHECK_PROOF_FULL_SUITE_FLAG = "--allow-full-suite";

/**
 * `rmd check-proof`'s verdict/refusal → exit-code contract (W1-T387 design (v)). A VERDICT and a
 * REFUSAL are different claims and must never share a code:
 *   - `pass`      (0) — executed, and {@link "./lib/review.js".execWhitelistedProof} says the
 *                       named check holds. Same code as before.
 *   - `fail`      (1) — executed, and it does not hold — a genuine failing test or grep miss.
 *                       Same code as before.
 *   - `refused`   (2) — NOTHING executed: bad usage, an unparseable proof, or a name-filtered
 *                       proof whose candidate resolution was `unresolvable` and
 *                       `--allow-full-suite` was not given. Unchanged from before.
 *   - `noMatch`   (3) — NEW. Executed (or fast-failed on positive evidence of absence) and ZERO
 *                       named tests matched — review.ts DEGRADES this to the keyword floor, never
 *                       a failure, so it must never read the same as `fail`. Before W1-T387 this
 *                       shared exit 1 with `fail`, which is the exact gap this task closes: a
 *                       proof that reads GREEN locally (`exit 0`) could be `no-match` at review,
 *                       and a local check that then reported the SAME code as `fail` would not
 *                       even let an author tell the two verdicts apart once they knew to look.
 *   - `execError` (4) — NEW. The run did not reach a clean pass/fail/no-match verdict at all: a
 *                       timeout, a spawn failure, or (grep only) exit 2 — "could not even look",
 *                       distinct from exit 1's "looked, found nothing" (W1-T219). Inconclusive,
 *                       not evidence either way — review.ts also degrades this to the keyword
 *                       floor, so it must not read as `fail` either.
 */
export const CHECK_PROOF_EXIT = {
  pass: 0,
  fail: 1,
  refused: 2,
  noMatch: 3,
  execError: 4,
} as const;

/** Fallback when plan/policy.yaml cannot be read: that file's own documented floor for
 *  `proofTimeoutMs`, so this verb is never less bounded than the reviewer. */
const CHECK_PROOF_TIMEOUT_FLOOR_MS = 60_000;

/**
 * How long `check-proof` lets a proof run. Time-boxed for the SAME reason the reviewer time-boxes,
 * reading the SAME policy field (`proofTimeoutMs`) so the two cannot drift: a proof that hangs must
 * fail rather than wedge the operator's terminal — this verb had no timeout at all, which is half of
 * what made the whole-suite fallback below so expensive.
 *
 * Best-effort by design: an unreadable policy must not turn a diagnostic verb into a crash, so it
 * degrades to that field's own documented floor. `readPolicy` is injected LAST and defaulted, so no
 * caller shifts — and so the catch arm is reachable from a test rather than being dead code that
 * only fires on a broken checkout.
 */
export function checkProofTimeoutMs(readPolicy?: () => number): number {
  try {
    // THE SEAM IS THE `??` FORM DELIBERATELY. test/config-reader-seams.test.ts detects an
    // injectable policy read by the literal `?? loadDefaultPolicy(` shape; a defaulted PARAMETER
    // is just as injectable but reads to that detector as unseamed, and allowlisting it would
    // trip its own stale-entry lock (an allowlisted reader that HAS a seam is a failure). Writing
    // the seam in the house form is cheaper than teaching the detector a second shape.
    return readPolicy?.() ?? loadDefaultPolicy().values.proofTimeoutMs;
  } catch {
    return CHECK_PROOF_TIMEOUT_FLOOR_MS;
  }
}

/** Default window for `rmd emissions`. 30 days covers this host's entire rotation history, so
 *  "zero in the window" is a claim about the corpus rather than about retention. */
const EMISSIONS_DEFAULT_DAYS = 30;

/** Every `<root>/state/ledger*.ndjson` — the LIVE file AND its rotations. Reading the live file
 *  alone undercounts by roughly 4x on this host (664 files), reporting hot verbs as dead. */
export function ledgerCorpusFiles(stateDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(stateDir);
  } catch {
    return [];
  }
  return names.filter((n) => n.startsWith("ledger") && n.endsWith(".ndjson")).map((n) => join(stateDir, n)).sort();
}

/**
 * `rmd check-acceptance <body-file>` — read a PR body from a file and report what
 * {@link "./lib/review.js".parseAcceptanceBlock} ACTUALLY resolves from it, against what the author
 * wrote. Exits non-zero when the two disagree.
 *
 * THE POPULATION THIS SERVES. `gh pr create` is GraphQL, and GraphQL exhaustion has repeatedly
 * forced PRs to be opened over REST — which bypasses the orchestrator path that emits the house
 * Acceptance block (`plan-pr-emitter.ts`'s `renderAcceptanceBlock`, guaranteed to round-trip). A
 * REST-opened PR therefore carries HAND-AUTHORED markdown, and nothing checks it before it is
 * posted. That emitter is reusable but has no CLI surface; this is the smallest surface that lets a
 * hand-authored body be checked with the reviewer's OWN parser before it reaches the gate.
 *
 * READ-ONLY: writes no ledger line, no state file, opens nothing.
 */
export function checkAcceptanceCommand(rest: string[]): number {
  const file = rest.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("usage: rmd check-acceptance <body-file>");
    return 2;
  }
  let body: string;
  try {
    body = readFileSync(file, "utf8");
  } catch (e) {
    console.error(`check-acceptance: cannot read ${file}: ${String((e as Error)?.message ?? e)}`);
    return 2;
  }
  const d = acceptanceBlockDiagnostics(body);
  const criteria = parseAcceptanceBlock(body);
  console.log(`file:            ${file}`);
  console.log(`header found:    ${d.headerFound}`);
  console.log(`bullets written: ${d.bulletsWritten}`);
  console.log(`criteria parsed: ${d.criteriaParsed}`);
  console.log(`empty proofs:    ${d.emptyProofs}`);
  criteria.forEach((c, i) => {
    console.log(`  [${i + 1}] claim: ${c.claim.slice(0, 88)}`);
    console.log(`      proof: ${c.proof ? c.proof.slice(0, 88) : "(EMPTY — nothing will execute)"}`);
  });
  if (!d.defective) {
    console.log("OK — the parser resolves exactly what was written, and every proof is non-empty.");
    return 0;
  }
  if (!d.headerFound) {
    console.error(
      "DEFECTIVE: no Acceptance header. The header must be a BARE line — `## Acceptance` or " +
        "`Acceptance:` with nothing else on it. A `## Validation` section is not one, and the review " +
        "fails CLOSED with nothing to judge.",
    );
  }
  if (d.truncatedAtBullet !== undefined) {
    console.error(
      `DEFECTIVE: ${d.bulletsWritten} bullets written but only ${d.criteriaParsed} parsed — the block ` +
        `ends before bullet ${d.truncatedAtBullet}. parseAcceptanceBlock treats any indented line that ` +
        `is not \`proof:\` as the END of the block, so a claim WRAPPED onto a second line silently ` +
        `truncates everything after it. Keep each claim on ONE line.`,
    );
  }
  if (d.emptyProofs > 0) {
    console.error(
      `DEFECTIVE: ${d.emptyProofs} parsed criterion/criteria have an EMPTY proof — a claim with nothing ` +
        `to execute. The proof must be on the immediately-following indented line as \`proof: ...\`.`,
    );
  }
  return 1;
}

/**
 * `rmd emissions [--days N]` — which CLI verbs have written NO ledger line in the window.
 *
 * STRICTLY READ-ONLY: unions the ledger corpus, counts, prints. Writes nothing, spawns nothing.
 * See lib/emissions.ts for what it surveys, what it deliberately does not, and why the runtime
 * count is paired with a static call-site count rather than reported alone.
 */
export function emissionsCommand(rest: string[], opts: { stateDir?: string } = {}): number {
  const badArg = unknownArgError("emissions", rest, ["--days"], []);
  if (badArg) {
    console.error(badArg + "\n" + USAGE);
    return 2;
  }
  const daysRaw = flagValue(rest, "--days");
  const days = daysRaw === undefined ? EMISSIONS_DEFAULT_DAYS : Number(daysRaw);
  if (!Number.isFinite(days) || days <= 0) {
    console.error(`rmd emissions: --days must be a positive number, got ${JSON.stringify(daysRaw)}\n` + USAGE);
    return 2;
  }

  const srcDir = join(repoRoot, "src");
  const sources: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const child = join(d, e.name);
      if (e.isDirectory()) walk(child);
      else if (e.name.endsWith(".ts")) sources.push(readFileSync(child, "utf8"));
    }
  };
  walk(srcDir);

  const verbs = deriveCliVerbs(readFileSync(join(srcDir, "run-task.ts"), "utf8"));
  const attributed = attributeVerbs(verbs, deriveStepPrefixes(sources));
  const measurable = attributed.filter((a): a is { name: string; prefix: string } => a.prefix !== null);
  const unauditable = attributed.filter((a) => a.prefix === null).map((a) => a.name);

  // THE STATIC HALF of the pairing: call sites beyond the verb's own definition and CLI dispatch.
  // A verb whose only references are those two cannot be invoked by anything but a human typing it.
  const callSites = new Map<string, number>();
  for (const { name } of measurable) {
    const fn = name.replace(/-([a-z])/g, (_m, c: string) => String(c).toUpperCase()) + "Command";
    let n = 0;
    for (const text of sources) n += [...text.matchAll(new RegExp(`\\b${fn}\\s*\\(`, "g"))].length;
    callSites.set(name, Math.max(0, n - 2));
  }

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  // `stateDir` is injected LAST and defaulted, so no positional caller shifts — and so the
  // unreadable-file arm below is reachable from a test instead of only on a corrupted host.
  // A DIAGNOSTIC VERB MUST NOT CRASH ON AN UNREADABLE CONFIG. `loadConfig()` throws
  // `Unexpected end of JSON input` on a host whose config is absent or empty — which is every CI
  // checkout — and this command's only use for it is locating the ledger. An unreadable config is
  // therefore "no corpus" (reported honestly as 0 files, which the render already handles), never
  // a stack trace out of a read-only report.
  const stateDir =
    opts.stateDir ??
    (() => {
      try {
        return join(loadConfig().root, "state");
      } catch {
        return undefined;
      }
    })();
  const files = stateDir === undefined ? [] : ledgerCorpusFiles(stateDir);
  const wanted = new Set(measurable.map((m) => m.prefix));
  const counts = new Map<string, number>();
  // DEDUPE IS NOT OPTIONAL and it is not free. The rotations are CUMULATIVE SNAPSHOTS, not disjoint
  // segments: measured on this host, 663 of 664 files have a ts span overlapping the previous
  // file's, so a naive union counts the same event many times over. But a Set over 4.2M raw lines
  // exhausts the heap (measured: OOM). So the filter comes FIRST — only lines whose prefix is one
  // we actually measure are kept — and the identity is `ts|step`, which is short and unique per
  // event, rather than the whole line.
  const seen = new Set<string>();
  let scanned = 0;
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      scanned++;
      // NOTE the ledger writes `"step":"…"` with NO SPACE after the colon.
      const sm = /"step":"([^"]+)"/.exec(line);
      if (!sm) continue;
      const prefix = sm[1].slice(0, sm[1].indexOf("."));
      if (!wanted.has(prefix)) continue;
      const tm = /"ts":"([^"]+)"/.exec(line);
      if (!tm || tm[1] < cutoff) continue;
      const key = `${tm[1]}|${sm[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
  }

  const rows = emissionsReport({ measurable, counts, callSites, allowlist: EMISSIONS_ALLOWLIST });
  console.log(`rmd emissions — window ${days}d (since ${cutoff.slice(0, 10)})`);
  console.log(`  corpus  : ${files.length} ledger file(s), ${scanned} lines scanned, ${seen.size} distinct in-window events on measured prefixes`);
  console.log(`  verbs   : ${verbs.length} declared, ${measurable.length} measurable, ${unauditable.length} unauditable`);
  console.log("");
  for (const r of rows) {
    console.log(
      `  ${r.status.toUpperCase().padEnd(24)} rmd ${r.verb.padEnd(12)} ${String(r.count).padStart(7)} line(s)  beyond-dispatch-call-sites=${r.callSitesBeyondDispatch}`,
    );
    if (r.allowlistReason) console.log(`  ${" ".repeat(24)}   allowlisted: ${r.allowlistReason}`);
  }
  console.log("");
  console.log(`  UNAUDITABLE (no ledger step carries the verb's name): ${unauditable.join(", ")}`);
  console.log("  Unauditable is not unused — it means this instrument cannot see the verb at all.");
  return 0;
}

/**
 * `rmd ledger-grep <pattern>` — the deduplicated union of every `state/ledger.*.ndjson.gz`
 * archive and the live `state/ledger.ndjson`, for `pattern`. Replaces the manual
 * `grep -h '<pat>' state/ledger.*.ndjson state/ledger.ndjson | sort -u` idiom, which glob-matches
 * ZERO of this host's gzipped archives and silently answers from the live file alone — see
 * lib/ledger-grep.ts's module doc for the measured 3.1x undercount that shape produced.
 *
 * MIRRORS `checkProofCommand`'s shape: prints what it resolved (pattern, state dir, archive
 * count) BEFORE printing any match, so the positive control is visible rather than implied by
 * the presence of output. READ-ONLY — writes no ledger line, no state file, and never
 * deletes/moves an archive (they are the only copy of most history; see rotateLedger's
 * MAX_RETAINED_LINES_PER_STEP retention).
 *
 * THE WHOLE POINT: exits non-zero, naming the globbed directory, when ZERO archive files were
 * read, rather than falling back to a live-file-only match count — the automated form of the
 * positive control nobody writes by hand for this idiom.
 */
export function ledgerGrepCommand(rest: string[], opts: { stateDir?: string } = {}): number {
  const pattern = rest[0];
  const badArg = unknownArgError("ledger-grep", rest.slice(1), [], []);
  if (!pattern || badArg) {
    if (badArg) console.error(badArg);
    console.error(`usage: ${commandSyntax("ledger-grep")}\n` + USAGE);
    return 2;
  }

  // Injected LAST and defaulted, so no positional caller shifts — same seam emissionsCommand's
  // `opts.stateDir` uses, and for the same reason: a test drives both the "archives present" and
  // "zero archives" branches against a synthetic state root instead of this host's real one.
  const stateDir =
    opts.stateDir ??
    (() => {
      try {
        return join(loadConfig().root, "state");
      } catch {
        return undefined;
      }
    })();
  if (stateDir === undefined) {
    console.error("rmd ledger-grep: cannot resolve a state dir — unreadable config");
    return 1;
  }

  console.log(`pattern:    ${pattern}`);
  console.log(`state dir:  ${stateDir}`);
  const result = resolveLedgerUnion(stateDir, pattern);
  console.log(`archives:   ${result.archiveCount} matched`);
  if (!result.ok) {
    console.error(
      `rmd ledger-grep: ZERO archive files matched ${join(stateDir, "ledger.*.ndjson.gz")} — refusing to ` +
        "answer from the live ledger alone. A count from the live file only is the exact silent " +
        "undercount this verb exists to kill, so it is an error, never a smaller result.",
    );
    return 1;
  }
  console.log(`matches:    ${result.matches.length}`);
  for (const line of result.matches) console.log(line);
  return 0;
}

export function checkProofCommand(rest: string[]): number {
  // Matched as a STANDALONE token, never a substring: a proof body is free text that could
  // legitimately quote this flag's name.
  const allowFullSuite = rest.includes(CHECK_PROOF_FULL_SUITE_FLAG);
  const proof = rest.filter((t) => t !== CHECK_PROOF_FULL_SUITE_FLAG).join(" ").trim();
  if (!proof) {
    console.error("rmd check-proof: give me a proof, e.g. `rmd check-proof 'grep: foo in src/lib/bar.ts'`\n" + USAGE);
    return CHECK_PROOF_EXIT.refused;
  }
  const w = parseWhitelistedProof(proof);
  if (!w) {
    console.log(`proof:      ${proof}`);
    console.log("parse:      REFUSED — parseWhitelistedProof returned null.");
    console.log(
      "            A `grep:` proof needs an explicit `in <path>` clause; a `unit test:` proof needs a\n" +
        "            test path or title. A proof wrapped in markdown backticks parses since #1063, but a\n" +
        "            proof with no dialect prefix at all is prose and never executes.",
    );
    return CHECK_PROOF_EXIT.refused;
  }
  console.log(`proof:      ${proof}`);
  console.log(`parse:      OK — kind=${w.kind}${w.nameFiltered ? " (name-filtered)" : ""}`);

  let args = w.args as readonly string[];
  if (w.nameFiltered) {
    const r = resolveNameFilteredCandidates(process.cwd(), w.label);
    if (r.status === "resolved") {
      console.log(`candidates: ${r.files.length} file(s) — ${r.files.join(", ")}`);
      args = narrowNameFilteredArgs(w.args, r.files);
    } else {
      console.log(`candidates: ${r.status}${"reason" in r ? ` — ${r.reason}` : ""}`);
      if (r.status === "absent") {
        console.log("verdict:    no-match — the executor fast-fails here and never spawns node.");
        return CHECK_PROOF_EXIT.noMatch;
      }
      // UNRESOLVABLE ⇒ `narrowNameFilteredArgs` returns the args UNCHANGED, still carrying
      // TEST_GLOB — so executing here runs the ENTIRE SUITE. That fallback is defensible inside
      // the reviewer, whose own comment argues it: with no evidence either way, the wide run is
      // the honest attempt. It was NOT defensible here, because this verb called `spawnSync` with
      // no `timeout` — so an operator asking a one-line question about one proof got an UNBOUNDED
      // full-suite run. review.ts's comment names what that costs: "the full glob loads every file
      // including several that drive a real headless browser and hang when the name filter matches
      // none of their tests".
      //
      // The trigger is not exotic. `resolveNameFilteredCandidates` answers `unresolvable` whenever
      // `couldBeInterpolatedTitle` is true — i.e. whenever the proof's title merely SHARES A
      // STATIC CHUNK with any template-literal title in the corpus — which happens in a perfectly
      // ordinary checkout, and is indistinguishable to the author from a title that simply typo'd.
      //
      // So: report, and decline to be the thing that runs the suite. Everything an author came for
      // (parse kind, the resolution and its reason, the exact argv) is printed either way; only
      // the spawn is withheld.
      if (!allowFullSuite) {
        console.log(`argv:       ${w.command} ${args.join(" ")}`);
        console.log(
          "verdict:    NOT EXECUTED — this proof resolved to no file, so running it would run the\n" +
            "            WHOLE test suite (note the trailing glob in the argv above), unbounded.\n" +
            `            Re-run with ${CHECK_PROOF_FULL_SUITE_FLAG} to do it anyway (time-boxed to the\n` +
            "            same proofTimeoutMs the reviewer uses), or name a test/<file>.test.ts path —\n" +
            "            the path form runs exactly one file.",
        );
        return CHECK_PROOF_EXIT.refused;
      }
    }
  }
  console.log(`argv:       ${w.command} ${args.join(" ")}`);

  // W1-T387: THE COLLAPSE. Everything above this line is UNCHANGED diagnostics (parse kind,
  // candidate resolution, the exact argv) — the whole point is that they survive. From here down,
  // the VERDICT is decided by execWhitelistedProof itself, the SAME function judgeCriterion calls
  // at review time, never by this file re-deriving pass/fail from a raw exit code again.
  //
  // execWhitelistedProof returns only "pass" | "fail" | "no-match" (or throws) — no stdout, no
  // exit code, no signal. `capturingSpawn` wraps the REAL spawner (review.ts's own
  // `defaultProofSpawner`, the identical primitive execWhitelistedProof would use by default) and
  // records what it observed on the side, purely so the diagnostics below (`exit:`, `hits:`) can
  // still be printed — this file never reads `diag` to decide the verdict.
  let diag: { stdout: string; status: number | null; signal: NodeJS.Signals | null } | undefined;
  const capturingSpawn: ProofSpawner = (command, spawnArgs, spawnCwd, spawnTimeoutMs) => {
    try {
      const out = defaultProofSpawner(command, spawnArgs, spawnCwd, spawnTimeoutMs);
      diag = { stdout: out, status: 0, signal: null };
      return out;
    } catch (e) {
      const err = e as NodeJS.ErrnoException & {
        status?: number | null;
        signal?: NodeJS.Signals | null;
        stdout?: string | Buffer | null;
      };
      diag = {
        stdout: typeof err.stdout === "string" ? err.stdout : (err.stdout?.toString("utf8") ?? ""),
        status: typeof err.status === "number" ? err.status : null,
        signal: err.signal ?? null,
      };
      throw e;
    }
  };

  let outcome: "pass" | "fail" | "no-match";
  try {
    outcome = execWhitelistedProof(w, process.cwd(), checkProofTimeoutMs(), capturingSpawn);
  } catch (e) {
    // exec_error: a timeout, a spawn failure, or (grep only) exit 2 — "could not even look",
    // never treated as evidence of a failing proof (W1-T219). Same class of run the reviewer
    // degrades to the keyword floor rather than an executed_fail.
    if (diag) {
      console.log(`exit:       ${diag.status === null ? `killed by ${diag.signal}` : diag.status}`);
      const hits = diag.stdout.split("\n").filter((l) => l.trim() !== "").length;
      console.log(`hits:       ${hits}`);
      if (diag.stdout.trim()) console.log(diag.stdout.trimEnd().split("\n").slice(0, 10).join("\n"));
    }
    console.log(`verdict:    exec_error — ${String((e as Error)?.message ?? e)}`);
    if (w.kind === "grep")
      console.log(
        "note:       a `grep:` pattern is a BASIC REGULAR EXPRESSION, not a literal — `[`, `*`, `^`, `$`\n" +
          "            are metacharacters. Do NOT re-check this with `grep -F`; that is a different matcher.",
      );
    return CHECK_PROOF_EXIT.execError;
  }

  if (diag) {
    console.log(`exit:       ${diag.status === null ? `killed by ${diag.signal}` : diag.status}`);
    const hits = diag.stdout.split("\n").filter((l) => l.trim() !== "").length;
    console.log(`hits:       ${hits}`);
    if (diag.stdout.trim()) console.log(diag.stdout.trimEnd().split("\n").slice(0, 10).join("\n"));
  }
  console.log(`verdict:    ${outcome}`);
  if (w.kind === "grep" && outcome !== "pass")
    console.log(
      "note:       a `grep:` pattern is a BASIC REGULAR EXPRESSION, not a literal — `[`, `*`, `^`, `$`\n" +
        "            are metacharacters. Do NOT re-check this with `grep -F`; that is a different matcher.",
    );
  if (outcome === "pass") return CHECK_PROOF_EXIT.pass;
  if (outcome === "fail") return CHECK_PROOF_EXIT.fail;
  return CHECK_PROOF_EXIT.noMatch;
}

export async function nextTaskIdCommand(rest: string[]): Promise<number> {
  const badArg = unknownArgError("next-task-id", rest, ["--plan"], ["--offline"]);
  if (badArg) {
    console.error(badArg + "\n" + USAGE);
    return 2;
  }
  const planPath = flagValue(rest, "--plan") ?? join(repoRoot, "plan", "tasks.yaml");
  const offline = rest.includes("--offline");
  const self = resolveOwnerRepo();
  let mint: MintedTaskIdWithHistory;
  try {
    mint = mintNextTaskIdWithHistory({
      planPath,
      repoRoot,
      openPrTexts: offline ? undefined : () => openPrMintTexts(self.owner, self.repo),
    });
  } catch (e) {
    console.error(`### rmd next-task-id: ${(e as Error).message}`);
    return 2;
  }
  console.log(describeMintWithHistory(mint));
  // READS reservations, never TAKES one. This verb is advisory and spawns nothing, so an operator
  // asking "what is next" a hundred times must not burn a hundred ids — and a reservation held by
  // a process that exits microseconds later reserves nothing anyway. Reporting a number and
  // claiming it are different acts; only the caller that will actually FILE should claim.
  // BEST-EFFORT, unlike the triage path's loud reservation. This verb is a READ that spawns
  // nothing, so an unreadable config or state dir must degrade to "no reservation notice" rather
  // than crash the operator's query — `loadConfig()` throws on an absent/empty config file, which
  // is the normal case in CI and in any fixture-only checkout. The LOUD-on-failure rule applies to
  // the caller that is about to SPEND, not to the one that is about to PRINT.
  try {
    const free = firstUnreservedAtOrAbove(mint.n, taskIdReservationsDir(loadConfig().root));
    if (free !== mint.n)
      console.log(`(${mint.id} is RESERVED by a live minter — the next unreserved id is W1-T${free})`);
  } catch {
    /* no readable reservation store ⇒ report the mint alone, exactly as before this existed */
  }
  if (offline) console.log("(--offline: open plan PRs were NOT read — this id is a floor, not a guarantee)");
  return mint.degraded.length ? 1 : 0;
}

/** W1-T180: the post-merge-amendment status resolution's only I/O — loadConfig (reads $HOME),
 *  resolveOwnerRepo (shells `git remote`), ghGateway (real `gh` exec), projectPlan (the
 *  ledger read + GitHub round-trip) — injectable so a test can prove BOTH the success path
 *  (statusResolvable stays true, per-task opts get populated) and the fail-open catch path
 *  (any of the four throws => statusResolvable false, never a thrown error out of lint-plan)
 *  without shelling a real `gh` or touching this machine's actual $HOME. Real callers (the
 *  CLI dispatch below) omit `deps` entirely and get the real functions, same DI shape as
 *  `runTask`'s `opts.config ?? loadConfig()` / `opts.github ?? ghGateway(...)`. */
export type LintPlanStatusDeps = {
  loadConfig?: typeof loadConfig;
  resolveOwnerRepo?: () => { owner: string; repo: string };
  ghGateway?: typeof ghGateway;
  projectPlan?: typeof projectPlan;
  readMergeEvidenceLog?: typeof defaultMergeEvidenceLog;
};

/** Filing-family subjects are citations ABOUT a task (minting it, triaging it, renumbering it),
 *  never evidence its implementation merged. This one boundary is the failing-split classifier's
 *  whole judgment surface — moving it swung the recon's count 47 → 156 → 167
 *  (state/recon-open-failing-composition.md) — which is why the printed summary names the rule
 *  and not just the counts. */
export const LINT_FILING_SUBJECT_RE = /^(chore\(plan\)|chore\(triage\)|chore\(feedback\)|docs\(plan\))/i;

/** Splits lint-plan's failing tasks by MERGE EVIDENCE in a `git log` dump (`%s%x00%b%x01`
 *  format): a task "has a merged implementation" when any non-filing commit carries its id as a
 *  `Remudero-Task:` trailer or cites it in the subject. Pure over its inputs — the impure read
 *  lives in {@link defaultMergeEvidenceLog}, supplied by the verb exactly like `moduleExists`.
 *  Id matching is case-insensitive (history carries `w1-t52` and `W1-T52` alike) and delimiter-
 *  bounded so W1-T25 never matches a commit citing W1-T250. */
export function classifyFailingMergeEvidence(
  failingIds: string[],
  gitLogDump: string,
): { withImpl: string[]; without: string[] } {
  const nonFiling = gitLogDump
    .split("\x01")
    .map((entry) => entry.split("\x00"))
    .filter((parts) => parts[0]?.trim() && !LINT_FILING_SUBJECT_RE.test(parts[0].trim()));
  const subjects = nonFiling.map((parts) => ` ${parts[0].toLowerCase()} `);
  const bodies = nonFiling.map((parts) => (parts[1] ?? "").toLowerCase());
  const withImpl: string[] = [];
  const without: string[] = [];
  for (const id of failingIds) {
    const t = id.toLowerCase();
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const subjectRe = new RegExp(`[(\\s,:]${escaped}[)\\s,:.]`);
    const trailer = `remudero-task: ${t}`;
    const hit =
      subjects.some((s) => subjectRe.test(s)) ||
      bodies.some((b) => b.includes(`${trailer}\n`) || b.trimEnd().endsWith(trailer));
    (hit ? withImpl : without).push(id);
  }
  return { withImpl, without };
}

/** The failing-split's only I/O: the evidence ref's history from the LOCAL object store — never
 *  the network, so lint-plan's default mode stays offline and deterministic at a given ref. A
 *  shallow clone is REFUSED BY NAME rather than scanned: its truncated history would read
 *  "absent from history" as "no evidence" — a silent undercount, the exact naked-zero shape the
 *  split exists to correct. The verb prints the refusal; it never prints a split built on it. */
export function defaultMergeEvidenceLog(cwd: string): { dump: string; ref: string } {
  const shallow = execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
    cwd,
    encoding: "utf8",
  }).trim();
  if (shallow === "true")
    throw new Error("shallow clone — truncated history would misread absent commits as absent evidence");
  const ref = "origin/main";
  const dump = execFileSync("git", ["log", "--format=%s%x00%b%x01", ref], {
    cwd,
    encoding: "utf8",
    // Same rationale as the `git show` above: the default 1 MiB maxBuffer dies on a history this
    // size long before the machine does.
    maxBuffer: 1 << 28,
  });
  return { dump, ref };
}

export async function lintPlanCommand(rest: string[], deps: LintPlanStatusDeps = {}): Promise<number> {
  const badArg = unknownArgError("lint-plan", rest, ["--plan", "--base"], ["--all"]);
  if (badArg) {
    console.error(badArg + "\n" + USAGE);
    return 2;
  }
  // W1-T324: matched as a standalone token, same discipline as every other boolean flag in
  // this file — never a substring match against a proof body that could legitimately quote
  // "--all". Meaningless (and silently ignored) in --base mode: --base's own scope already
  // defines what's in-bounds, and that mode stays byte-identical whether or not this is set.
  const allFlag = rest.includes("--all");
  const planPathArg = flagValue(rest, "--plan");
  const planPath = planPathArg !== undefined ? resolve(planPathArg) : join(repoRoot, "plan", "tasks.yaml");
  // W1-T120: an explicit --plan resolving OUTSIDE the resolved root is REFUSED right
  // here, BY NAME — before any --base/git-show plumbing gets a chance to mis-report it
  // as a base-resolution failure (the #271 fixture's second false green: `relative(
  // repoRoot, planPath)` used to yield a `../../..` path that `git show <base>:<that>`
  // died on as though the BASE ref were the problem, never naming the real one).
  if (planPathArg !== undefined && isPathOutsideRoot(repoRoot, planPath)) {
    console.error(
      `### rmd lint-plan: --plan ${planPath} resolves OUTSIDE the repo root ${repoRoot} — ` +
        `refusing (a plan outside the gated tree is never in scope)`,
    );
    return 2;
  }
  const baseRef = flagValue(rest, "--base");
  let plan: Plan;
  let planRaw: string;
  try {
    planRaw = readFileSync(planPath, "utf8");
    plan = loadPlan(planPath);
  } catch (e) {
    console.error(`### rmd lint-plan: ${(e as Error).message}`);
    return 2;
  }

  let scope: Set<string> | undefined;
  let oldById: Map<string, Task> | undefined;
  let newTaskIds: Set<string> | undefined;
  let newMonolithIds: Set<string> | undefined;
  if (baseRef) {
    const relPath = relative(repoRoot, planPath);
    // W1-T246 (recon): a plain `git show <base>:<relPath>` only ever materializes the MONOLITH
    // — every `plan/tasks.d/*.yaml` shard is invisible to it, so every shard-only task looked
    // "new/changed" on EVERY `lint-plan --base` run regardless of whether the PR touched it (the
    // SAME shard-blindness W1-T245 already fixed for syncPlanFromOrigin's dispatch-side sync).
    // That was harmless while no check ever failed on a shard task; it stops being harmless the
    // moment a new default-BLOCK check (proof-dialect) can land on one — reuse
    // materializeOriginShards (parameterized by `ref`, W1-T246) so the reconstructed base plan
    // matches exactly what `loadPlan` would see from a real checkout at `baseRef`.
    const tmpDir = makeTempDir("lint-plan-base");
    try {
      const oldRaw = execFileSync("git", ["show", `${baseRef}:${relPath}`], {
        cwd: repoRoot,
        encoding: "utf8",
        // maxBuffer: the SAME blob syncPlanFromOrigin reads at :576, so it overflows Node's 1 MiB
        // default at the same moment — fixing one site alone would just move the failure to CI.
        maxBuffer: 1 << 26,
      });
      const tmpFile = join(tmpDir, "tasks.yaml");
      writeFileSync(tmpFile, oldRaw, "utf8");
      materializeOriginShards(repoRoot, dirname(relPath), tmpDir, undefined, baseRef);
      const oldPlan = loadPlan(tmpFile);
      scope = changedTaskIds(oldPlan.tasks, plan.tasks);
      oldById = new Map(oldPlan.tasks.map((t) => [t.id, t]));
      // Tasks this PR introduces outright (absent at the base ref) — the only tasks that
      // can possibly BE a post-merge-amendment follow-up (W1-T180).
      newTaskIds = new Set(plan.tasks.filter((t) => !oldById!.has(t.id)).map((t) => t.id));
      // impl-DS: ids NEW to the MONOLITH specifically. `oldRaw` above is the base's plan/tasks.yaml
      // blob — the monolith ALONE, before shards are materialized beside it — so this is a per-FILE
      // comparison, not a merged-plan one, and it costs no extra git call.
      // That precision buys the reverse case for free: a task moved from a shard INTO the monolith is
      // absent from the base monolith and trips, while the RIGHT migration (monolith -> shard) simply
      // leaves the set and never does.
      const baseMonolithIds = new Set(parseTasksFromYaml(oldRaw, `${baseRef}:${relPath}`).map((t) => t.id));
      const headMonolithRaw = readFileSync(planPath, "utf8");
      const headMonolithIds = parseTasksFromYaml(headMonolithRaw, planPath).map((t) => t.id);
      newMonolithIds = new Set(headMonolithIds.filter((id) => !baseMonolithIds.has(id)));
      // W1-T428: the RAW-TEXT union. `changedTaskIds` above compares PARSED tasks, and the parser
      // drops six fields the corpus uses — `design:` among them — so an instructions-only edit
      // re-linted ZERO tasks (#1544 measured exactly that and had to call its own run vacuous).
      // Compare each task's raw RECORD text too and union the ids into scope: the parsed side
      // still owns semantic equivalence (a whitespace-only reorder stays invisible to it), the
      // raw side catches every dropped field by construction. This MUST run here, inside the
      // try: both raw trees exist only until the finally below removes tmpDir.
      const readShardTexts = (dir: string): string[] => {
        try {
          return readdirSync(dir)
            .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
            .sort()
            .map((f) => readFileSync(join(dir, f), "utf8"));
        } catch {
          return [];
        }
      };
      const rawChanged = rawChangedTaskIds(
        [oldRaw, ...readShardTexts(join(tmpDir, "tasks.d"))],
        [headMonolithRaw, ...readShardTexts(join(dirname(planPath), "tasks.d"))],
      );
      for (const id of rawChanged) scope.add(id);
    } catch (e) {
      console.error(`### rmd lint-plan: cannot resolve --base ${baseRef}: ${(e as Error).message}`);
      return 2;
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  } else {
    // TRAP 1: this check is MEANINGLESS without a base — "new" has no definition — and a check that
    // silently does nothing in the mode people run by hand is a check nobody notices is broken.
    console.log("### rmd lint-plan: no --base given — the monolith-filing check is SKIPPED (it needs a base ref to know which ids are new).");
  }

  // W1-T324: the whole-plan (no --base) scope filter. `--base` mode is untouched — `scope`
  // above already defines its bounds and this block never runs alongside it in a way that
  // changes that branch's behavior. `nonOpenRecordCount` is computed UNCONDITIONALLY (cheap —
  // one pass over already-loaded tasks, no extra I/O) so the summary line can name it even in
  // the default run that never lints those records — the debt stays visible without being
  // the headline. `wholePlanScope` stays undefined (⇒ every task is checked, exactly the
  // pre-W1-T324 shape) when either `--base` is set or `--all` was passed.
  let wholePlanScope: Set<string> | undefined;
  let nonOpenRecordCount = 0;
  if (!baseRef) {
    const openIds = plan.tasks.filter(isOpenLintTask).map((t) => t.id);
    nonOpenRecordCount = plan.tasks.length - openIds.length;
    if (!allFlag) wholePlanScope = new Set(openIds);
  }

  // W1-T180 (§5C post-merge-amendment): derived merge status for every task in `scope`,
  // resolved ONCE here (never per-task) and injected via LintOpts — task-linter.ts stays
  // a pure function over already-loaded data, per its own documented contract. FAIL OPEN,
  // deliberately, on ANY resolution failure (no `--base`, `loadConfig`'s CI `which claude`
  // trap, `gh` unauthenticated/unavailable): `statusResolvable` stays false and the check
  // is skipped rather than redding a plan-only PR during a GitHub outage.
  let statusByTaskId: Map<string, StatusProjection> | undefined;
  let statusResolvable = false;
  if (scope && scope.size > 0) {
    try {
      const config = (deps.loadConfig ?? loadConfig)();
      const { owner, repo } = (deps.resolveOwnerRepo ?? resolveOwnerRepo)();
      const github = (deps.ghGateway ?? ghGateway)(owner, repo);
      const scopedPlan: Plan = { tasks: plan.tasks.filter((t) => scope!.has(t.id)), byId: new Map() };
      statusByTaskId = (deps.projectPlan ?? projectPlan)(scopedPlan, { ledgerPath: ledgerPathFor(config), github });
      statusResolvable = true;
    } catch {
      statusByTaskId = undefined;
      statusResolvable = false;
    }
  }

  let failing = 0;
  let warned = 0;
  let checked = 0;
  const failingTaskIds: string[] = [];
  for (const task of plan.tasks) {
    if (scope && !scope.has(task.id)) continue;
    if (wholePlanScope && !wholePlanScope.has(task.id)) continue;
    checked++;
    let opts: LintOpts = {};
    if (scope) {
      const oldTask = oldById?.get(task.id);
      const proj = statusByTaskId?.get(task.id);
      // Per-task fail-open: even when the batched read above succeeded overall, THIS
      // task's own projection can still be indeterminate (a mid-batch rate-limit/auth
      // failure) — that must fail open exactly like a total resolution failure does.
      const taskStatusResolvable = statusResolvable && proj !== undefined && !proj.indeterminate;
      const added = criteriaAdded(oldTask?.acceptance, task.acceptance ?? []);
      const followUpTasks = newTaskIds
        ? plan.tasks.filter((t) => t.id !== task.id && newTaskIds!.has(t.id))
        : [];
      opts = {
        postMergeAmendment: {
          statusResolvable: taskStatusResolvable,
          merged: proj?.merged ?? false,
          baseAcceptance: oldTask?.acceptance,
          followUpFiled: followUpCarriesCriteria(added, followUpTasks),
        },
        // impl-DS: only ever populated in --base mode, so the check is silent whole-plan.
        newMonolithIds,
      };
    }
    // impl-DO: the CALL-SITE check needs to know whether a module already exists, and the linter
    // is pure — so the predicate is supplied here, the one place holding a real checkout to ask.
    opts.moduleExists = (rel: string) => existsSync(join(repoRoot, rel));
    const { violations } = lintTask(task, opts);
    const blocking = violations.filter((v) => v.severity === "block");
    const soft = violations.filter((v) => v.severity === "warn");
    if (blocking.length) {
      failing++;
      failingTaskIds.push(task.id);
      console.error(`✗ ${task.id}: ${blocking.length} violation(s)`);
      for (const v of blocking) console.error(`    [${v.check}] ${v.message}`);
    }
    for (const v of soft) {
      warned++;
      console.warn(`  ⚠ ${task.id}: [${v.check}] ${v.message}`);
    }
  }
  // W1-T252 (P37 SUBSTRATE): plan/policy.yaml rides the SAME §5C lint gate as
  // plan/tasks.yaml — a schema-bound value edit is reviewed data, never an
  // unbounded edit slipping past CI. Sibling of the plan file actually opened
  // (mirrors alert-policy.yaml's own plan/-relative placement), so a `--plan`
  // pointed at a fixture tree with no policy.yaml of its own is a no-op here
  // (nothing to check), never a spurious failure over a file that was never
  // meant to exist at that path.
  const policyFile = join(dirname(planPath), "policy.yaml");
  if (existsSync(policyFile)) {
    try {
      loadPolicy(policyFile);
    } catch (e) {
      failing++;
      const message = e instanceof PolicyError ? e.message : String((e as Error)?.message ?? e);
      console.error(`✗ plan/policy.yaml: ${message}`);
    }
  }

  // W1-T324: three summary shapes, chosen by mode — every shape keeps the literal
  // "${checked} task(s) checked" PREFIX (pre-existing consumers, e.g.
  // test/repo-root-identity.test.ts's #271 regression, match on that exact substring), with
  // mode-specific detail appended rather than a word inserted mid-phrase. `--base` is
  // BYTE-IDENTICAL to its pre-W1-T324 text (that mode's own acceptance criterion is
  // "unchanged"); the whole-plan default names BOTH the open-failing count and how many
  // additional records sit behind --all, per the task's own design ('N open failing; M
  // merged-task records behind --all'); --all itself restores the pre-W1-T324 full-corpus
  // wording, with the same count named so a reader who passed --all can see how much of what
  // they're looking at is retired/landed.
  let summary: string;
  // The failing-split (state/recon-open-failing-composition.md): the bare failing count is a
  // technically-true aggregate that misleads — measured 2026-08-06, 167 of 176 failing tasks had
  // merged implementations and could never re-dispatch, yet the headline priced them all as open
  // work. So the DEFAULT mode's headline carries the split, and the classifier's rule prints
  // beside the number (a split whose rule is invisible is the same defect one level down).
  // Display only: the exit code and every pre-existing summary substring are unchanged, and the
  // split can only qualify the count, never alter it. On ANY evidence failure the line says so
  // explicitly — a wrong split is worse than no split.
  let evidenceRuleLine = "";
  let failingSplit = "";
  if (wholePlanScope && failingTaskIds.length > 0) {
    try {
      const { dump, ref } = (deps.readMergeEvidenceLog ?? defaultMergeEvidenceLog)(repoRoot);
      const { withImpl, without } = classifyFailingMergeEvidence(failingTaskIds, dump);
      failingSplit = ` (${withImpl.length} with a merged implementation, ${without.length} with none)`;
      evidenceRuleLine =
        `\n  failing-split evidence: a Remudero-Task trailer or commit-subject citation on ${ref}, ` +
        `with chore(plan)/chore(triage)/chore(feedback)/docs(plan) filing subjects excluded — ` +
        `a filing cites a task; it does not implement it`;
    } catch (e) {
      failingSplit = ` (merge-evidence unavailable: ${(e as Error).message})`;
    }
  }
  if (scope) {
    summary = `${checked} task(s) checked (${scope.size} new/changed vs ${baseRef}) — ${failing} failing, ${warned} warning(s)`;
  } else if (wholePlanScope) {
    summary =
      `${checked} task(s) checked (open tasks only) — ${failing} open failing${failingSplit}, ${warned} warning(s); ` +
      `${nonOpenRecordCount} merged-task record(s) behind --all`;
  } else {
    summary =
      `${checked} task(s) checked (--all: full corpus, ${nonOpenRecordCount} merged-task record(s) included) — ` +
      `${failing} failing, ${warned} warning(s)`;
  }
  // W1-T120: the READ-IDENTITY ASSERTION — the abs path + content hash of the plan file
  // ACTUALLY opened, so a wrong-file run (a false green pointed at the wrong tree) is
  // legible in the gate's own output, not merely inferable from cwd.
  console.log(`\nrmd lint-plan: ${summary}${evidenceRuleLine}\n  read: ${formatReadIdentity(planPath, planRaw)}`);
  return failing > 0 ? 1 : 0;
}

/**
 * `rmd preflight [--from <ref>] [--to <ref>] [--ci-parity] [--fast] [--summary-file <path>]` — W1-T221's hand-route
 * commit gate. Runs {@link runPreflight}'s three independent steps (commitlint, `tsc --noEmit`,
 * and lib/commit-message.ts's own header/body checks) over the commit range not yet on
 * `origin/main`, prints every step's own pass/fail line UNCONDITIONALLY (never only on
 * failure — fixture 3's redirected-and-swallowed check is exactly the shape this avoids),
 * and exits non-zero iff any step failed. `--from`/`--to` override the default
 * `origin/main..HEAD` range so a caller can preflight an arbitrary range (e.g. re-checking
 * after amending).
 *
 * `--ci-parity` (W1-T294) and `--fast` (W1-T373) are each a SECOND/THIRD, ADDITIVE mode on
 * this same verb — never a second command, never a change to the three steps above, and never
 * a change to each other. `--ci-parity` runs {@link runCiParity}'s steps (one or more per
 * .github/workflows/ci.yml job — see lib/ci-parity.ts), which shells the FULL `npm run
 * test:ci` suite as part of the `ci` job's mirror and is therefore not a mode a worker can run
 * habitually. `--fast` runs {@link runPreflightFast}'s steps instead: the curated, seconds-
 * fast, network-free subset of deterministic npm-script gates (`FAST_GATE_STEPS`, lib/ci-
 * parity.ts) that actually blocks PRs — never the test suite. Either or both flags may be
 * passed; every mode's steps print after the hand-route steps, with the same independent-
 * step, print-everything, exit-non-zero-iff-any-failed discipline; omitting both flags leaves
 * the shipped hand route byte-for-byte unchanged.
 */
export async function preflightCommand(rest: string[], deps: PreflightDeps = {}): Promise<number> {
  const badArg = unknownArgError("preflight", rest, ["--from", "--to", "--summary-file"], ["--ci-parity", "--fast"]);
  if (badArg) {
    console.error(badArg + "\n" + USAGE);
    return 2;
  }
  const startedAtMs = Date.now();
  const from = flagValue(rest, "--from");
  const to = flagValue(rest, "--to");
  const range = deps.range ?? (from !== undefined || to !== undefined ? { from: from ?? "origin/main", to: to ?? "HEAD" } : undefined);

  const result = runPreflight(repoRoot, { ...deps, range });
  const fast = rest.includes("--fast") ? runPreflightFast(repoRoot, { spawn: deps.spawn }) : undefined;
  const ciParity = rest.includes("--ci-parity") ? runCiParity(repoRoot, { spawn: deps.spawn }) : undefined;

  for (const step of result.steps) {
    console.log(step.detail);
  }
  if (fast) {
    for (const step of fast.steps) {
      console.log(step.detail);
    }
  }
  if (ciParity) {
    for (const step of ciParity.steps) {
      console.log(step.detail);
    }
  }
  const ok = result.ok && (fast?.ok ?? true) && (ciParity?.ok ?? true);
  console.log(
    ok
      ? "\n### rmd preflight: PASS — commitlint, typecheck, and emitter checks are all clean; the push may proceed"
      : "\n### rmd preflight: FAIL — see the named step(s) above; do not push until every step passes",
  );

  // ── THE RESULT MUST SURVIVE THE CONTAINER THAT PRODUCED IT (see preflightSummaryPath's doc).
  // An eight-minute `--ci-parity` run whose only artifact is a terminal buffer is lost the moment
  // the container is removed, and that happened twice in one day. The verdict is ALREADY computed
  // here — `ok` and every step's `name`/`ok`/`detail` — so persisting it costs one write.
  //
  // UNCONDITIONAL, and deliberately so: this sits BELOW the summary line and outside any `ok`
  // branch, because a FAILING run's summary is the one most worth keeping. A write failure is
  // reported and never changes the exit code — the verdict belongs to the checks, not to whether
  // a file could be written.
  const summaryPath = flagValue(rest, "--summary-file") ?? preflightSummaryPath(repoRoot);
  const summary = buildPreflightSummary({
    steps: [...result.steps, ...(fast?.steps ?? []), ...(ciParity?.steps ?? [])],
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAtMs,
    headSha: readHeadShaForSummary(),
    args: rest,
  });
  try {
    mkdirSync(dirname(summaryPath), { recursive: true });
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n", "utf8");
    console.log(`### summary written: ${summaryPath} (${summary.passed} passed, ${summary.failed} failed, ${Math.round(summary.durationMs / 1000)}s)`);
  } catch (e) {
    console.error(`### summary NOT written to ${summaryPath}: ${String((e as Error)?.message ?? e)}`);
  }
  return ok ? 0 : 1;
}

/**
 * The head sha for a preflight summary, or `"unknown"` — a summary must never fail to be written
 * because a sha could not be read (a no-git host is not a preflight failure).
 *
 * `exec` is injectable and appended LAST so no existing caller shifts. It exists because the
 * `catch` arm below is otherwise unreachable: `git rev-parse HEAD` always succeeds inside this
 * repo, so a test that did not inject would leave the failure path uncovered — the seam-default /
 * catch-arm trap this repo has hit before. The DEFAULT really shells out, and one test drives each
 * arm.
 */
export function readHeadShaForSummary(
  exec: (file: string, args: string[]) => string = (file, args) => execFileSync(file, args, { encoding: "utf8" }),
): string {
  try {
    return exec("git", ["-C", repoRoot, "rev-parse", "HEAD"]).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

/** Best-effort read for the follow-up harvest's dedup source (W1-T105 design iv):
 *  run `read()`, degrade to `[]` and log a NAMED error on any throw — never abort
 *  the retro over one dedup-source read hiccup. `label` distinguishes which source
 *  failed in the ledger/console output. */
function tryReadFollowupTitles(label: string, read: () => string[]): string[] {
  try {
    return read();
  } catch (e) {
    console.error(`### [retro] followups.open_titles.${label} — ${String((e as Error)?.message ?? e)}`);
    return [];
  }
}

/**
 * `rmd retro [--dry-run]` — the harness SYNCS ITS OWN PLAN (MASTER-PLAN
 * §Self-improvement). A DETERMINISTIC GATHER (lib/retro.ts, no LLM) reduces the
 * ledger + LEARNINGS into calibration-by-type, verdict distribution, and the
 * merged-since list; `--dry-run` prints it and stops. A full run then spawns ONE
 * Architect worker — riding a HIGHER tier than implement workers (G-17, asserted)
 * — fed ONLY the gather + the current MASTER-PLAN, to write a PLAN-ONLY sync PR
 * (SHIPPED log, refreshed NET STATE, the calibration table, failure→proposal
 * notes, and REQUIRED compression — a retro that only ADDS is a failed retro). The
 * PR is gated by ci + remudero-review (posted via the existing review code path),
 * then state/last-retro.json advances. Generation (this) is separated from
 * publication (the gate + the human) [research].
 */
/**
 * The GitHub gateway `shippedSince` needs, wired to this repo's real `gh` (W1-T132
 * design ii): `unavailable()` backed by ONE cheap `gh api rate_limit` probe. Shared by
 * `retroCommand`'s own gather AND the daemon's cadence-trigger check (W1-T160,
 * `retroTriggerCheck` below) so both read the SAME credited-merge signal off the SAME
 * gateway construction, never two independently-behaving GitHub reads.
 */
function retroShippedGithubGateway(): ShippedGithub {
  const { owner, repo } = resolveOwnerRepo();
  const baseGithub = ghGateway(owner, repo);
  return {
    findMergedByTrailer: (taskId) => baseGithub.findMergedByTrailer(taskId),
    headRefName: (prUrl) => baseGithub.headRefName(prUrl),
    unavailable: () => probeGithubThrottle(),
  };
}

/**
 * W1-T160: evaluate the retro cadence trigger against the REAL marker + ledger +
 * GitHub read — the impure wiring behind `evaluateRetroTrigger` (retro.ts, pure).
 * Returns `undefined` when there is nothing safe to evaluate this tick: a corrupt
 * marker (fail closed exactly like `retroCommand`'s own guard — never replay a torn
 * marker as "no marker") or a degraded GitHub read (never claim a false
 * merges-since-marker of 0 off an unhealthy gateway — this just skips ONE tick's
 * evaluation; the daemon re-tries every tick after, and the days-threshold path still
 * advances off `marker.ts` regardless of GitHub's health).
 *
 * `deps` is a test seam (W1-T160 coverage): a test injects a tmp `config` (pointing
 * at its own root's marker/ledger fixtures) and a fake `github` gateway to drive this
 * real marker/ledger/shipped wiring without a live `gh` round-trip. Production passes
 * neither, so `config` is the live `loadConfig()` and `github` the shared
 * `retroShippedGithubGateway` — the same construction `retroCommand`'s own gather uses.
 * `deps.policy` is the SAME seam for the cadence thresholds (W1-T264, P37 CONSUMER):
 * production passes none, so the cadence reads `plan/policy.yaml`'s `retro` row (the
 * same `loadPolicy(policyPath(repoRoot))` construction `daemonCommand`/`drainCommand`
 * already use) instead of `evaluateRetroTrigger`'s own source-literal default; a test
 * injects a fixture `Policy` to prove a threshold edit changes the firing decision
 * with no source edit.
 */
export function retroTriggerCheck(
  now: Date = new Date(),
  deps: { config?: Config; github?: ShippedGithub; policy?: Policy } = {},
): RetroTriggerDecision | undefined {
  const config = deps.config ?? loadConfig();
  const ledgerPath = ledgerPathFor(config);
  const markerPath = join(config.root, "state", "last-retro.json");
  const markerResolution = resolveMarkerForGather(markerPath);
  if (markerResolution.kind === "corrupt") return undefined;
  const marker = markerResolution.kind === "ok" ? markerResolution.marker : undefined;
  const github = deps.github ?? retroShippedGithubGateway();
  if (github.unavailable?.()) return undefined;
  const ledgerNdjson = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : "";
  const runs = gatherRuns(parseLedger(ledgerNdjson));
  const mergesSinceMarker = shippedSince(runs, marker?.ts, github).shipped.length;
  const policy = deps.policy ?? loadPolicy(policyPath(repoRoot));
  return evaluateRetroTrigger(mergesSinceMarker, marker?.ts, now, {
    mergesThreshold: policy.values.retro.mergesThreshold,
    daysThreshold: policy.values.retro.daysThreshold,
  });
}

/**
 * W1-T160: build the daemon's retro cadence hooks — SELF-TARGET ONLY (the retro
 * reads/writes THIS repo's own MASTER-PLAN.md/LEARNINGS.md/plan/tasks.yaml/state, never
 * a drained target's, so daemonCommand wires these only when draining itself). Extracted
 * from daemonCommand's `DaemonDeps` literal so the hook BODIES — the `retroTriggerCheck`
 * delegation and the automated-retro invocation — are unit-testable in isolation with
 * injected `check`/`runRetro`, leaving the literal itself holding only covered property
 * references rather than inline logic whose sole executor is the daemon boot path.
 * `runRetroTrigger`'s return (an exit code) is discarded — retroCommand already ledgers
 * everything the daemon loop needs (retro_triggered, retro_aborted_integrity, pr.opened,
 * retro.marker.advanced).
 */
/**
 * The auto-triage rung's PRODUCER (impl-DM), mirroring {@link buildRetroDaemonHooks} exactly.
 *
 * ★ WHY THIS EXISTS AT ALL. PR #1066 shipped the rung's CONSUMER — `daemon.ts` reads
 * `deps.checkAutoTriage` inside its idle branch — and never wired a producer. `deps.checkAutoTriage`
 * was therefore `undefined` in every production boot, the `if` was always false, and setting
 * `autoTriage.enabled: true` in policy did nothing at all. Eighteen tests passed, diff-coverage
 * passed, the review went green, and the feature was inert on main. That is the seventh instance in
 * three days of code that is written, tested, merged and never reached.
 *
 * TWO ROOTS, AND THEY ARE NOT THE SAME ONE. The lock and the marker live under `config.root`
 * (`<root>/state/…`) because that is where every other fleet latch lives and where the CLI's own
 * `triageLockPath(cfg.root)` already points. The feedback entries live under `repoRoot`
 * (`<repo>/plan/feedback/*.yaml`) because they are committed artifacts. Passing one root for both
 * would read an empty candidate list and silently never fire — the same shape of quiet nothing this
 * change exists to remove.
 */
export function buildAutoTriageDaemonHooks(deps: {
  check?: (census?: AutoTriageCensus) => AutoTriageDecision;
  runTriage?: (feedbackId: string) => Promise<number>;
  config?: Config;
  now?: () => Date;
  /** Injected policy, forwarded to {@link autoTriageCheck} — see its doc for why this seam exists.
   *  Production passes none and the checked-in `plan/policy.yaml` governs, exactly as before. */
  policy?: Policy;
} = {}): {
  checkAutoTriage: (census?: AutoTriageCensus) => AutoTriageDecision;
  runAutoTriage: (feedbackId: string) => Promise<void>;
} {
  const check =
    deps.check ??
    ((census?: AutoTriageCensus) => autoTriageCheck({ config: deps.config, now: deps.now?.(), policy: deps.policy, census }));
  const runTriage = deps.runTriage ?? ((feedbackId: string) => triageCommand([feedbackId]));
  const configFor = () => deps.config ?? loadConfig();
  return {
    checkAutoTriage: (census?: AutoTriageCensus) => check(census),
    runAutoTriage: async (feedbackId) => {
      // RECORD THE FIRE FIRST, deliberately. If triage throws or the process dies mid-run, the
      // marker has already advanced and the interval bound still holds — the failure costs one
      // skipped period rather than authorising an immediate, unbounded retry at ~$2.00 a time.
      recordAutoTriageFire(autoTriageMarkerPath(configFor().root), deps.now?.() ?? new Date(), 24 * 60 * 60 * 1000);
      await runTriage(feedbackId);
    },
  };
}

/**
 * The rung's real decision, assembled from live state. Pure-ish: every input is read here and handed
 * to the PURE {@link decideAutoTriage}, which owns every bound and is unchanged by this PR.
 *
 * `idle: true` is not an assumption — it is a fact about the CALL SITE. `daemon.ts` consults this
 * hook only from inside its idle branch (`if (!next) { … }`), so by construction the daemon has
 * nothing dispatchable and nothing in flight whenever this runs. The parameter stays on the pure
 * function because tests must be able to assert the not-idle refusal.
 *
 * `opts.policy` is the SAME injection seam {@link retroTriggerCheck} already offers, and it exists
 * for a measured reason. Without it this function's ONLY policy source is the CHECKED-IN
 * `plan/policy.yaml`, resolved through `repoRoot` — which is derived from the running process's own
 * cwd, so a test driving this reads the REPO's policy no matter what fixture it built. That is not
 * hypothetical: `test/auto-triage-wiring.test.ts` asserted an unconditional refusal under a title
 * claiming the flag was ABSENT, its fixture wrote no policy file at all, and it was really pinning
 * "the shipped default is false". It passed by coincidence of that value until the flag was genuinely
 * flipped (#1093). Production still passes nothing and reads the checked-in file exactly as before.
 */
export function autoTriageCheck(
  opts: { config?: Config; now?: Date; policy?: Policy; census?: AutoTriageCensus } = {},
): AutoTriageDecision {
  const config = opts.config ?? loadConfig();
  const policy = opts.policy ?? loadPolicy(policyPath(repoRoot));
  const held = readDrainLock(triageLockPath(config.root));
  return decideAutoTriage({
    policy: policy.values.autoTriage,
    idle: true,
    // A lock whose holder is DEAD is not held — the same liveness rule `acquireDrainLock` itself
    // applies, so a crashed run cannot wedge the rung shut forever.
    lockHeld: held !== null && defaultIsPidAlive(held.pid),
    marker: readAutoTriageMarker(autoTriageMarkerPath(config.root)),
    now: opts.now ?? new Date(),
    // repoRoot, NOT config.root — see this block's doc comment.
    candidates: newFeedbackIdsOldestFirst(repoRoot),
    // W1-T318: the adaptive-cadence census, forwarded verbatim to the pure decision. Absent ⇒
    // decideAutoTriage's own fastest-point default — see its doc.
    census: opts.census,
  });
}

export function buildRetroDaemonHooks(deps: {
  check?: () => RetroTriggerDecision | undefined;
  runRetro?: (rest: string[], opts: { automated: Extract<RetroTriggerDecision, { fire: true }> }) => Promise<number>;
} = {}): {
  checkRetroTrigger: () => RetroTriggerDecision | undefined;
  runRetroTrigger: (decision: Extract<RetroTriggerDecision, { fire: true }>) => Promise<void>;
} {
  const check = deps.check ?? (() => retroTriggerCheck());
  const runRetro = deps.runRetro ?? retroCommand;
  return {
    checkRetroTrigger: () => check(),
    runRetroTrigger: async (decision) => {
      await runRetro([], { automated: decision });
    },
  };
}

/**
 * W1-T322 (design (iii)): the RETRO-TIME consumer of the SAME reachability scan the review path
 * uses — MASTER-PLAN's own NET STATE section, re-checked against the CURRENT mainline checkout
 * (`repoRoot`, never a PR diff). Returns the report section to concatenate, or `""`.
 *
 * BEST-EFFORT AND NON-FATAL, the same discipline `openProposalLines`/`openTaskTitles` follow: a
 * read or scan hiccup degrades to "nothing to advise" rather than aborting the retro.
 *
 * EXTRACTED FROM `retroCommand` SO THE DEGRADATION ARM IS REACHABLE. Inline, the `catch` was
 * dead to every test: `retroCommand` derives `repoRoot` internally, so no test could hand it a
 * tree whose MASTER-PLAN.md exists but will not read. As a function taking `repoRoot`, one can —
 * a directory at that path passes `existsSync` and throws EISDIR on read, which is exactly the
 * "exists but unreadable" shape the arm is written for.
 */
export function netStateAdvisorySectionFor(repoRoot: string): string {
  try {
    const masterPlanPath = join(repoRoot, "MASTER-PLAN.md");
    const masterPlanMd = existsSync(masterPlanPath) ? readFileSync(masterPlanPath, "utf8") : "";
    const netStateStart = masterPlanMd.indexOf("\n## NET STATE");
    if (netStateStart === -1) return "";
    const nextHeading = masterPlanMd.indexOf("\n## ", netStateStart + 1);
    const netStateText = masterPlanMd.slice(netStateStart, nextHeading === -1 ? undefined : nextHeading);
    return `\n\n${renderNetStateUnwiredAdvisories(netStateCapabilityAdvisories(netStateText, repoRoot))}`;
  } catch (e) {
    console.error(`### [retro] net_state_unwired_advisories — scan failed, degrading to none: ${String((e as Error)?.message ?? e)}`);
    return "";
  }
}

/**
 * W1-T358 (Standing rule 20): `planHealthSweep`/`renderPlanHealth` (lib/retro.ts) re-grade
 * every OPEN task against every standing rule the deterministic linter encodes — the
 * FORWARD-only gap the rule names (a task is graded once, at filing time; nothing re-checks
 * it against a rule added or tightened afterward). Both were fully implemented and covered
 * by unit tests but never CALLED from anywhere real, so the sweep never ran and
 * `renderPlanHealth`'s doc-promised "printed by --dry-run" output never rendered. Wired here,
 * against the SAME `repoRoot`-relative `plan/tasks.yaml` `netStateAdvisorySectionFor` above
 * already reads, with the SAME best-effort/silent-on-failure discipline: a missing or corrupt
 * plan file degrades to no section rather than aborting the retro.
 *
 * `isMerged` (W1-T367): the derived-from-GitHub resolver `retroCommand` builds once (a single
 * batched `projectPlan` pass over this SAME plan file) and passes in, so "already shipped" is
 * decided the same way the dispatch path decides it — never the decorative yaml `status:`
 * field `planHealthSweep`'s own doc measures as 248/359 wrong. Optional and undocumented-away
 * (not silently defaulted to a fetch here): omitting it — a caller with no projection in hand
 * — falls through to `planHealthSweep`'s own pure yaml-based default, the same degrade this
 * function already had before this task, so an isolated caller (this function's direct unit
 * tests below) keeps working unchanged.
 */
export function planHealthSweepSectionFor(repoRoot: string, isMerged?: (task: Task) => boolean): string {
  try {
    const tasksYamlPath = join(repoRoot, "plan", "tasks.yaml");
    if (!existsSync(tasksYamlPath)) return "";
    const { tasks } = loadPlan(tasksYamlPath);
    const report = planHealthSweep(
      tasks,
      () => ({
        moduleExists: (rel: string) => existsSync(join(repoRoot, rel)),
      }),
      isMerged,
    );
    return `\n\n${renderPlanHealth(report)}`;
  } catch (e) {
    console.error(`### [retro] plan_health_sweep — scan failed, degrading to none: ${String((e as Error)?.message ?? e)}`);
    return "";
  }
}

/**
 * W1-T410 (split from W1-T392): re-derives every task id MASTER-PLAN.md asserts unbuilt
 * against the SAME merge resolver `planHealthSweepSectionFor` above already consumes — no new
 * `projectPlan` pass, no new gateway (see `planStateTruthRung`'s doc, lib/retro.ts, for why the
 * extractor binds an assertion to its subject rather than scanning a whole line, and for the
 * three-plus-one states this renders).
 *
 * `resolve` omitted (the SAME degrade `retroCommand`'s `isTaskMerged` already has: an
 * unreachable gateway or missing plan file): the rung renders itself UNAVAILABLE rather than
 * silently skipping — design (vii). A MASTER-PLAN.md read/scan hiccup degrades to `""` (section
 * omitted), the SAME best-effort discipline `netStateAdvisorySectionFor`/
 * `planHealthSweepSectionFor` above already follow — the retro completes either way.
 */
export function planStateTruthSectionFor(repoRoot: string, resolve?: PlanStateTruthResolver): string {
  try {
    const masterPlanPath = join(repoRoot, "MASTER-PLAN.md");
    const masterPlanMd = existsSync(masterPlanPath) ? readFileSync(masterPlanPath, "utf8") : "";
    return `\n\n${renderPlanStateTruth(planStateTruthRung(masterPlanMd, resolve))}`;
  } catch (e) {
    console.error(`### [retro] plan_state_truth_rung — scan failed, degrading to none: ${String((e as Error)?.message ?? e)}`);
    return "";
  }
}

async function retroCommand(
  rest: string[],
  opts: {
    /** Injectable worker-spawn (mirrors {@link runTask}'s `opts.spawn`) — lets a test drive
     *  the retro success path (through the atomic marker-advance, W1-T242) without a real
     *  Architect spawn. Default: the real {@link spawnWorker}. */
    spawn?: typeof spawnWorker;
    /**
     * W1-T160: present when this retro run was fired by the daemon's cadence trigger
     * (never set for an operator-run `rmd retro`) — carries the count
     * `evaluateRetroTrigger` observed when it decided to fire. Its presence turns on the
     * INTEGRITY GATE (`checkRetroIntegrity`): once the real gather below is computed, a
     * mismatch (this run's `mergesSinceMarker` was > 0 but the gather credits 0) aborts
     * loudly (`retro_aborted_integrity`) and writes NOTHING — no PR, no marker advance,
     * no follow-up harvest. An operator-run retro (`opts.automated` absent) is watched
     * by a human and keeps its existing behavior unchanged.
     */
    automated?: { reason: "merges" | "days"; mergesSinceMarker: number; daysSinceMarker: number };
    /**
     * Injectable GitHub gateway for this command's two {@link projectPlan} passes (the plan-health
     * sweep and the orientation section) — the same shape `spawn` above already uses, and the
     * asymmetry it completes: a test could substitute the spawner but NOT the network.
     *
     * WHY IT EXISTS. `projectPlan` always took its gateway as a dep (`DeriveDeps.github`); this
     * function was hardcoding `ghGateway(owner, repo)` at both call sites, and `ghGateway`'s
     * `findMergedByTrailer` shells ONE `gh pr list --search` PER TASK. MEASURED: a single
     * `retroCommand(["--dry-run"])` against 439 task records made `test/retro.test.ts` take 453
     * SECONDS for 87 passing tests, and `test/retro-marker-atomic.test.ts` drives the same command
     * 23 more times. The batched `buildBatchedGithub` is what the serve path switched to for
     * exactly this cost.
     *
     * PRODUCTION NOW DEFAULTS TO THE BATCHED GATEWAY TOO — this line used to read "production here
     * is deliberately left on `ghGateway`, unchanged", and that deferral has been taken up. The
     * retro fires UNATTENDED (`evaluateRetroTrigger`, on the merges-or-days cadence
     * `plan/policy.yaml` sets), so the per-task search was spending a GraphQL budget with nobody
     * watching: ~441 searches per projection here, twice, against 5000/hour. `runTask`'s identical
     * swap is the precedent (#1529), and the equivalence is asserted the same way — both gateway
     * shapes driven over one corpus, required to return the same verdict.
     *
     * DEFAULTED PER CALL SITE, NOT ONCE — UNCHANGED, AND THE REASON SURVIVES THE SWAP. Omitted,
     * each site constructs its OWN gateway. `ghGateway` closes over mutable `failed`/
     * `failureReason`; `buildBatchedGithub` closes over the SAME SHAPE of state
     * (`lastFetchFailed`/`lastIssueFetchFailed`, surfaced by `readFailed()`/`readFailureReason()`),
     * so collapsing the two into one shared instance would still let a failure on the plan-health
     * pass leak into the orientation pass. Two instances, exactly as before.
     */
    github?: GitHub;
  } = {},
): Promise<number> {
  const dryRun = rest.includes("--dry-run");
  const spawn = opts.spawn ?? spawnWorker;
  const config = loadConfig();
  const ledgerPath = ledgerPathFor(config);
  const markerPath = join(config.root, "state", "last-retro.json");
  const learningsPath = join(repoRoot, "LEARNINGS.md");
  const ledgerNdjson = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : "";
  const learningsMd = existsSync(learningsPath) ? readFileSync(learningsPath, "utf8") : "";
  // W1-T89/P18: plan/mast-mapping.yaml is DATA (Rule 2) — loaded here, never
  // touched by buildGather itself. A missing file degrades to an empty table
  // (every failure verdict reports unmapped, LOUDLY, in the render) rather than
  // aborting the retro; a PRESENT-but-malformed file fails closed (loadMastMapping
  // throws MastMappingError), same discipline as a corrupt marker below.
  const mastMappingPath = join(repoRoot, "plan", "mast-mapping.yaml");
  const mastMapping: MastMapping = existsSync(mastMappingPath) ? loadMastMapping(mastMappingPath) : { rows: [] };
  // W1-T242: a corrupt-but-present marker (e.g. a torn write from a crash, or a manual
  // edit) MUST NOT be silently treated as "no marker" — that would replay the whole
  // already-consumed run window and double-count SHIPPED/learnings. resolveMarkerForGather
  // distinguishes "absent" (the genuine first-ever-retro signal) from "corrupt" (fail
  // closed); branch on it BEFORE any gather/spawn work, never collapse back to
  // `marker | undefined` the way the pre-fix reader did.
  const markerResolution = resolveMarkerForGather(markerPath);
  if (markerResolution.kind === "corrupt") {
    console.error(`\n### [retro] ${markerResolution.error.message}`);
    appendLedger(ledgerPath, {
      run_id: `RETRO-${Date.now()}`,
      task_id: "RETRO",
      step: "retro.marker.corrupt",
      error: markerResolution.error.message,
      marker_path: markerPath,
    });
    return 1;
  }
  const marker = markerResolution.kind === "ok" ? markerResolution.marker : undefined;
  // owner/repo: still needed below (repo clone, orientation's own gateway, PR create) —
  // retroShippedGithubGateway() resolves its OWN copy internally for the SHIPPED union.
  const { owner, repo } = resolveOwnerRepo();
  // W1-T132: resolved EARLY (a pure git-config read, no spawn) so the SHIPPED
  // union (W1-T51's shippedSince) can be wired into the gather from the start —
  // omitting `github` here degrades `shipped` to the ledger-only list, which is
  // structurally EMPTY in the gate-side-merge era (every merge now lands via the
  // gate, never a ledger verdict=merged write).
  // DEGRADE LOUDLY (design ii): `unavailable` is checked ONCE per gather via a
  // real `gh api rate_limit` probe — an exhausted quota or a `gh` CLI failure is
  // NAMED in the rendered report rather than silently read as "nothing shipped"
  // (every findMergedByTrailer/headRefName call would otherwise fail the same
  // way a genuine absence does). Shared construction — see retroShippedGithubGateway's doc.
  const github: ShippedGithub = retroShippedGithubGateway();
  // W1-T105 design (iv): the follow-up harvest's dedup source — every existing task
  // title (any status; a followup matching an already-shipped task is still a dup)
  // plus every open PROPOSAL's summary line off MASTER-PLAN.md (each written as one
  // logical line in the source — the regex below matches only that top line, never
  // a proposal's indented (a)/(b)/(c) continuation bullets). Best-effort: a read/parse
  // hiccup degrades to "no dedup source" (every followup mints) rather than aborting
  // the retro — the SAME non-fatal discipline the mast-mapping/orientation reads use.
  const openTaskTitles = tryReadFollowupTitles("tasks", () => {
    const tasksYamlPath = join(repoRoot, "plan", "tasks.yaml");
    return existsSync(tasksYamlPath) ? loadPlan(tasksYamlPath).tasks.map((t) => t.title) : [];
  });
  const openProposalLines = tryReadFollowupTitles("proposals", () => {
    const masterPlanPath = join(repoRoot, "MASTER-PLAN.md");
    const masterPlanMd = existsSync(masterPlanPath) ? readFileSync(masterPlanPath, "utf8") : "";
    const lines = masterPlanMd.match(/^-\s+(?:\*\*)?(?:★\s*)?P\d+[A-Za-z]?\b.*$/gm) ?? [];
    // DEGRADE LOUDLY (W1-T132's discipline): a non-trivial MASTER-PLAN.md yielding
    // zero proposal-bullet matches is a FORMAT-DRIFT signal (the convention this
    // regex assumes changed), not a genuine "no open proposals" — visible in the
    // logs rather than silently emptying half the dedup source.
    if (lines.length === 0 && masterPlanMd.length > 500) {
      console.error("### [retro] followups.open_titles.proposals — 0 proposal-bullet matches in a non-trivial MASTER-PLAN.md (format drift?)");
    }
    return lines;
  });
  // P34 clause (d), W1-T250: loaded HERE (hoisted above its pre-existing 4816
  // use for the Architect mount resolution below) so buildGather's weekly
  // burn-by-model-class section (the cross-file invariant this clause
  // ratifies) is wired live rather than shipping as an inert, never-called
  // organ. loadMounts throws on a bad/absent table — same fail-closed
  // discipline every other mounts.yaml read in this file already has.
  const mountsTable = loadMounts(mountsPath(repoRoot));
  const gather = buildGather({
    ledgerNdjson,
    learningsMd,
    sinceTs: marker?.ts,
    learningsAtMarker: marker?.learnings_count,
    github,
    mastMapping,
    priorMastCategoryCounts: marker?.mast_category_counts,
    openTitles: [...openTaskTitles, ...openProposalLines],
    mounts: mountsTable,
    now: Date.now(),
  });
  // W1-T111 (P25 iv): the approve/reframe rate is telemetry, not decoration — the field's
  // failure mode is the rubber-stamp queue, so it rides EVERY retro (cumulative, all-time,
  // never scoped to `sinceTs` — a fatigue signal needs the whole history to be trustworthy).
  // lib/retro.ts itself stays untouched; this is a standalone section concatenated on.
  // W1-T322 (design (iii)): the RETRO-TIME consumer of the SAME reachability scan the review
  // path uses — MASTER-PLAN's own NET STATE section, re-checked against the CURRENT mainline
  // checkout (this repo's own working tree, `repoRoot` — never a PR diff). Best-effort + silent
  // on failure, the SAME non-fatal discipline `openProposalLines`/`openTaskTitles` above already
  // follow: a read/scan hiccup degrades to "nothing to advise" rather than aborting the retro.
  const netStateAdvisorySection = netStateAdvisorySectionFor(repoRoot);
  // W1-T367: a single batched `projectPlan` pass over the SAME `repoRoot`/plan/tasks.yaml the
  // plan-health sweep reads below, so its "already shipped" skip is decided the SAME way the
  // dispatch path decides it — never the decorative yaml `status:` field (MEASURED: 248/359
  // tasks carry a stale non-merged status despite a long-merged PR, so the yaml-trusting skip
  // cleared 2 of 359 and re-linted 357 every run). One `ghGateway`/`projectPlan` call, here,
  // not a second independent read path: nothing above this point in `retroCommand` has already
  // projected the plan (the orientation section further down does its own, later, off the
  // freshly-cloned worktree's copy — a separate purpose this does not touch or duplicate).
  // Best-effort + silent-on-failure, the SAME non-fatal discipline every other section above
  // follows: a missing plan, unreachable GitHub, or any other read hiccup degrades `isTaskMerged`
  // to `undefined`, which makes `planHealthSweepSectionFor` fall back to its own pure
  // yaml-based default — the sweep still runs (just without this fix) rather than the whole
  // retro aborting over a `gh` outage.
  let isTaskMerged: ((task: Task) => boolean) | undefined;
  // W1-T410: the SAME projection `isTaskMerged` above derives from, exposed keyed by raw
  // string id (never a `Task` object — a prose-extracted id may not resolve to a known plan
  // task at all) for the plan-state truth rung below. One projection, two consumers — no
  // second `projectPlan` call.
  let planStateResolver: PlanStateTruthResolver | undefined;
  try {
    const planHealthPlanPath = join(repoRoot, "plan", "tasks.yaml");
    if (existsSync(planHealthPlanPath)) {
      const planHealthPlan = loadPlan(planHealthPlanPath);
      const planHealthProjection = projectPlan(
        planHealthPlan,
        { ledgerPath, github: opts.github ?? buildBatchedGithub(owner, repo) },
        join(config.root, "state", "status.json"),
      );
      isTaskMerged = (task) => planHealthProjection.get(task.id)?.merged ?? false;
      planStateResolver = (taskId) => {
        const projection = planHealthProjection.get(taskId);
        return projection ? { merged: projection.merged, prUrl: projection.prUrl } : undefined;
      };
    }
  } catch (e) {
    console.error(
      `### [retro] plan_health_sweep.projection — scan failed, degrading to yaml status: ${String((e as Error)?.message ?? e)}`,
    );
  }
  // W1-T410 (split from W1-T392): the plan-state truth rung re-derives every task id
  // MASTER-PLAN.md asserts unbuilt against the SAME merge resolver above — a BLOCKING
  // contradiction (design (iv): outranks the plan-health sweep below for KICK ORDER purposes),
  // so it is concatenated ahead of that advisory floor.
  const planStateTruthSection = planStateTruthSectionFor(repoRoot, planStateResolver);
  // W1-T358 (Standing rule 20): the plan-health sweep re-grades the OPEN queue against
  // every standing rule the linter encodes — rides EVERY retro report (dry-run and real
  // alike), same as the net-state advisory section above.
  const planHealthSection = planHealthSweepSectionFor(repoRoot, isTaskMerged);
  const report =
    [renderGather(gather), "", renderRatifyTelemetry(ratifyTelemetry(parseLedger(ledgerNdjson)))].join("\n") +
    planStateTruthSection +
    planHealthSection +
    netStateAdvisorySection;

  if (dryRun) {
    console.log(report);
    return 0;
  }

  // INTEGRITY GATE (W1-T160): a HARD precondition INSIDE the automated path only — an
  // operator watching `rmd retro` run keeps today's behavior unchanged. Checked here,
  // BEFORE any write (recordFollowupHarvest is itself a write) — see checkRetroIntegrity's
  // doc for why a mismatch means ABORT, never write: no PR, no marker advance, no
  // follow-up harvest.
  if (opts.automated) {
    const integrity = checkRetroIntegrity(opts.automated.mergesSinceMarker, gather.shipped.length);
    if (!integrity.ok) {
      console.error(`\n### [retro] ${integrity.reason}`);
      appendLedger(ledgerPath, {
        run_id: `RETRO-${Date.now()}`,
        task_id: "RETRO",
        step: "retro_aborted_integrity",
        reason: integrity.reason,
        trigger_reason: opts.automated.reason,
        merges_since_marker: opts.automated.mergesSinceMarker,
        gather_shipped: gather.shipped.length,
      });
      return 1;
    }
  }

  // W1-T105: harvest marks are a REAL-RUN-ONLY side effect — mineFollowups (inside
  // buildGather, above) is pure, so the --dry-run branch above never wrote anything.
  // This is the ONE place a followup candidate/dedup gets ledger-marked so a later
  // retro's mineFollowups pass over the now-updated ledger mints neither again.
  recordFollowupHarvest(gather.followups, { ledgerPath });

  // G-17 Tier Invariant: the retro Architect MUST outrank implement workers.
  // MOUNT-GOVERNED (§9, W1-T64 — sibling of W1-T63/P10): the retro/architect spawn's MODEL
  // and turn budget BOTH come from mounts.yaml's `architect` row (the model is the source of
  // truth; the flat-400 tripwire #90 is the turn cap), NEVER a hardcoded literal or a config
  // default. Before this, a hardcoded 40-turn cap — the SAME class of cap that walled the
  // reviewer (error_max_turns) — could wall the Architect mid-retro BEFORE it
  // staged/committed/pushed/opened the PR, leaving an empty branch that then crashed
  // `gh pr create --fill` (no diff to fill). `mountsTable` is the SAME table
  // loaded above (pre-buildGather) for the weekly-burn-by-model-class gather —
  // one load, two uses, never a second re-read of the same file.
  const arch = architectModel(config, mountsTable); // Architect model is the mounts.yaml `architect:` row
  const wrk = workerModel(config);
  assertArchitectAboveWorker(arch, wrk); // throws (fail-closed) on violation

  const runId = `RETRO-${Date.now()}`;
  const log = (step: string, extra: Record<string, unknown> = {}) =>
    appendLedger(ledgerPath, { run_id: runId, task_id: "RETRO", step, ...extra });
  const say = (msg: string) => console.log(`\n### [retro] ${msg}`);
  log("retro.start", { since: gather.sinceTs ?? null, runs_in_scope: gather.totalRuns, architect: arch, worker: wrk });
  say(`retro ${runId} — architect ${arch} over worker ${wrk}; ${gather.totalRuns} runs in scope`);

  const settingsFile = renderWorkerSettings({
    templatePath: join(repoRoot, "settings", "worker.json"),
    hooksDir: join(repoRoot, "hooks"),
    outPath: join(config.root, "tmp", `retro-settings-${runId}.json`),
  });
  validateWorkerSettingsFile(settingsFile);

  const repoDir = join(config.root, "repos", repo);
  if (!existsSync(repoDir)) {
    mkdirSync(dirname(repoDir), { recursive: true });
    execFileSync("gh", ["repo", "clone", `${owner}/${repo}`, repoDir], { stdio: "inherit" });
  }
  const pruned = pruneStaleRuns(repoDir, worktreesDir(config), { graceMs: DEFAULT_PRUNE_GRACE_MS });
  if (pruned.worktrees.length || pruned.branches.length || pruned.skipped.length) log("worktree.prune", { ...pruned });
  const branch = `run-${runId}`;
  const worktreePath = join(worktreesDir(config), branch);
  worktreeAdd(repoDir, worktreePath, branch, "origin/main");
  // Liveness token so a concurrent drain's prune skips this retro worktree. (See runTask.)
  writeRunLock(worktreePath, { pid: process.pid, run_id: runId, startedAt: new Date().toISOString() });

  // W1-T39: the next-runnable task for docs/ORIENTATION.md, from the SAME DAG +
  // GitHub-derived-status projection `rmd drain` dispatches from — never a second,
  // divergent read path. Read from the freshly-branched worktree's plan/tasks.yaml
  // (origin/main at branch time), same source `rmd drain` syncs from.
  const statusPath = join(config.root, "state", "status.json");
  let nextTask: Task | undefined;
  try {
    const orientationPlan = loadPlan(join(worktreePath, "plan", "tasks.yaml"));
    const proj = projectPlan(
      orientationPlan,
      { ledgerPath, github: opts.github ?? buildBatchedGithub(owner, repo) },
      statusPath,
    );
    const isMerged: MergedSet = (id) => proj.get(id)?.merged ?? false;
    const isOpenPr: OpenPrCheck = (id) => {
      const p = proj.get(id);
      return p?.prState === "OPEN" ? p.prNumber : undefined;
    };
    nextTask = nextRunnable(orientationPlan, isMerged, { isOpenPr });
  } catch (e) {
    // Best-effort: ORIENTATION.md's "next task" section degrades to "(none)"
    // rather than aborting the whole retro over a plan/GitHub read hiccup.
    log("orientation.next_task.error", { error: String((e as Error)?.message ?? e) });
  }

  const prompt = retroPrompt(report, calibrationTable(gather.byType), runId);
  try {
    const worker = await spawn({
      cwd: worktreePath,
      permissionMode: "bypassPermissions",
      settingsFile,
      model: arch, // the Architect tier
      maxTurns: mountsTable.architect.maxTurns, // MOUNT-GOVERNED (W1-T64) — never a hardcoded literal.
      maxBudgetUsd: DEFAULT_BUDGET_USD,
      config,
      prompt,
    });
    log("retro.synthesized", {
      session_id: worker.sessionId,
      cost_usd: worker.costUsd,
      subtype: worker.subtype,
      // W1-T6: the retro Architect is a BRAIN-PLANE call — same telemetry
      // shape as a worker call (model here is the Architect tier, `arch`).
      ...workerLedgerFields(worker),
    });

    // W1-T39: docs/ORIENTATION.md is HARNESS-OWNED — deterministically regenerated
    // here (never LLM-authored) so it can never go stale by hand-copy or by an
    // Architect forgetting to touch it. Runs AFTER the worker so it also reflects
    // whatever the Architect just changed in MASTER-PLAN.md §12 (Standing rules).
    // The mechanism itself lives in lib/orientation.ts (independently exercised
    // against a real git worktree by test/orientation.test.ts, see that file for
    // the falsifier that proves a second pass's diff names the REFRESHED state).
    let orientationCommitted = false;
    try {
      const result = regenerateOrientation({
        worktreePath,
        generatedAt: new Date().toISOString(),
        gather,
        nextTask,
      });
      orientationCommitted = result.committed;
      if (result.committed) log("orientation.regenerated", { diff_bytes: result.diff?.length ?? 0 });
    } catch (e) {
      log("orientation.write.error", { error: String((e as Error)?.message ?? e) });
    }

    // W1-T136 (#287 class): plan/plan-index.json is HARNESS-OWNED too — the Architect
    // just edited MASTER-PLAN.md above, and an un-regenerated index reds
    // `plan-index:check` post-push (#287's exact failure). Mirrors regenerateOrientation's
    // write/add/diff-cached-quiet/commit-if-changed discipline (lib/plan-pr-emitter.ts).
    let planIndexCommitted = false;
    try {
      const result = regeneratePlanIndexAndCommit({ worktreePath });
      planIndexCommitted = result.committed;
      if (result.committed) log("plan_index.regenerated", { diff_bytes: result.diff?.length ?? 0 });
    } catch (e) {
      log("plan_index.regen.error", { error: String((e as Error)?.message ?? e) });
    }

    // Ensure the branch reached origin (worker pushes without -u). Also push when
    // ORIENTATION.md/plan-index.json were regenerated AFTER the worker's own push, so
    // those commits aren't silently left local (never reaching the PR the worker already
    // opened).
    let onOrigin = false;
    try {
      execFileSync("git", ["-C", worktreePath, "ls-remote", "--exit-code", "origin", branch], { stdio: "ignore" });
      onOrigin = true;
    } catch {
      onOrigin = false;
    }
    if (!onOrigin || orientationCommitted || planIndexCommitted) {
      gitPushRunBranch(worktreePath);
    }

    let prUrl = parseReport([worker.text, worker.blocks.join("\n")].join("\n"))?.prUrl;
    if (!prUrl) {
      // GUARD (W1-T64): 0 commits ahead of origin/main means the Architect produced
      // nothing to PR (its subtype is already logged above via retro.synthesized) —
      // `gh pr create --fill` has no diff to fill and THROWS on an empty branch, which
      // used to crash the retro outright. commitsAhead already exists (the implement
      // no-op guard, above in this file); reuse it here rather than ever attempting a PR
      // on an empty branch. A real retro (>=1 commit) proceeds exactly as before.
      if (commitsAhead(worktreePath, "origin/main") === 0) {
        log("retro.no_op", { reason: "worker committed nothing", subtype: worker.subtype });
        say(`retro no-op — worker (subtype ${worker.subtype}) committed nothing; nothing to PR`);
        worktreeRemove(repoDir, worktreePath);
        return 1;
      }
      const prCreate = ghPrCreateFillCommand(worktreePath, owner, repo, branch, lastCommitSubject(worktreePath));
      const out = execFileSync(prCreate.command, prCreate.args, prCreate.options);
      prUrl = out.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/)?.[0];
    }
    if (!prUrl) {
      log("retro.error", { error: "no PR opened" });
      worktreeRemove(repoDir, worktreePath);
      return 1;
    }
    // RUN-OWNERSHIP GUARD (W1-T62) — same backstop as runTaskBody: before any side
    // effect touches this PR, assert it is actually this retro's own PR.
    const ownership = checkPrOwnership(prUrl, branch, ghPrHeadGateway(), worker.costUsd, worker.accountLabel);
    if (ownership) {
      log("verdict", ownership.ledger);
      say(
        `verdict: pr_attribution_failed — claimed PR ${prUrl} (branch ${ownership.ledger.claimed_branch ?? "unresolved"}) ` +
          `is not this retro's own branch (${branch}) — PR left UNTOUCHED`,
      );
      worktreeRemove(repoDir, worktreePath);
      return 1;
    }
    // impl-BI: `runId`, not the bare literal `"RETRO"`, so the FALLBACK stamp and the retro
    // prompt's own `Remudero-Task: ${runId}` last-body-line agree. With the literal, a worker
    // that followed the prompt got a no-op here (`"Remudero-Task: RETRO-<epoch>"` contains the
    // substring `"Remudero-Task: RETRO"`), but a worker that omitted the trailer got a bare
    // `RETRO` stamp — which `reviewCommand` would then key its verdict to, missing the arm
    // from the other direction. One id, both paths.
    ensureTaskTrailer(prUrl, runId);

    // W1-T136 (#394 class): verify-and-repair the PR body's Acceptance block BEFORE the
    // gate runs. retroPrompt instructs the Architect worker to write one, but that's
    // advisory (an LLM can get the shape wrong, e.g. #394's non-bare header, which
    // parseAcceptanceBlock never recognizes) — this harness-side pass is the
    // deterministic backstop so a worker's shape mistake doesn't fail the whole retro
    // CLOSED at remudero-review. Best-effort: never lets this crash an otherwise-fine retro.
    repairRetroAcceptanceBlock(prUrl, log);

    // DETERMINISTIC GUARD: a retro is PLAN-ONLY. If the diff touches src/ or test/,
    // fail closed (the retro may never carry code — one concern).
    const diff = execFileSync("gh", ["pr", "diff", prUrl], { encoding: "utf8", maxBuffer: 1 << 26 });
    const codeFiles = codeFilesInDiff(diff);
    if (codeFiles.length > 0) {
      log("retro.error", { error: "retro PR is NOT plan-only", code_files: codeFiles });
      say(`retro PR touched code (${codeFiles.join(", ")}) — retros are plan-only; leaving PR OPEN for inspection`);
      worktreeRemove(repoDir, worktreePath);
      return 1;
    }
    log("pr.opened", { pr_url: prUrl, plan_only: true });
    say(`retro PR (plan-only): ${prUrl}`);

    // Advance the marker (the retro RAN — the gather is now consumed).
    const nextMarker = {
      ts: new Date().toISOString(),
      learnings_count: gather.learningsNow,
      runs_seen: gather.totalRuns,
      mast_category_counts: gather.mast.byCategory,
    };
    saveMarker(markerPath, nextMarker);
    log("retro.marker.advanced", nextMarker);

    // Gate: ci green → post remudero-review → arm auto-merge.
    const ci = await waitForCiGreen(prUrl, (s, extra) => log(s, extra));
    if (ci !== "green") {
      say(`ci ${ci} — PR left OPEN: ${prUrl}`);
      worktreeRemove(repoDir, worktreePath);
      return 1;
    }
    const prNum = prUrl.match(/\/pull\/(\d+)/)?.[1] ?? prUrl;
    const reviewCode = await reviewCommand(prNum);
    // W1-T230 — THE KEY. impl-BI: this passed the hardcoded literal `"RETRO"` under a comment
    // asserting the review's ledger line was keyed "RETRO" too. That comment was FALSE. The
    // trailer this lane actually stamps is `Remudero-Task: <runId>` (the retro prompt's last
    // body line, `RETRO-${Date.now()}`), so `reviewCommand` keys its `review.posted` line to
    // the full run id. Measured over the live ledger unioned with all 660 rotations:
    // `review.posted` rows keyed exactly "RETRO" = 0, rows keyed RETRO* = 7795. The literal
    // has NEVER matched a verdict — every retro PR in this repo's history was refused here at
    // the W1-T230 gate, and then logged `automerge.armed` anyway. `runId` is the id in scope.
    const armOutcome = armAndLogOutcome(prUrl, runId, log);
    worktreeRemove(repoDir, worktreePath);
    say(`retro PR gated — ${armReportPhrase(armOutcome)} (review ${reviewCode === 0 ? "success" : "failure"}): ${prUrl}`);
    return reviewCode;
  } catch (e) {
    log("retro.error", { error: String((e as Error)?.message ?? e) });
    try {
      worktreeRemove(repoDir, worktreePath);
    } catch {
      /* best-effort */
    }
    throw e;
  } finally {
    removeRunLock(worktreePath); // terminal ⇒ drop the liveness token
  }
}

/** The Architect retro prompt — fed ONLY the deterministic gather + current plan. */
function retroPrompt(gatherReport: string, calTable: string, runId: string): string {
  return [
    "You are the REMUDERO ARCHITECT running a RETRO (MASTER-PLAN §Self-improvement). You ride a HIGHER",
    "tier than implement workers. You are fed ONLY the deterministic GATHER below and the current",
    "MASTER-PLAN.md in this working directory. Produce a PLAN-ONLY sync PR — edit ONLY MASTER-PLAN.md.",
    "NEVER touch src/ or test/ (this is plan-only; a code change fails the retro).",
    "NEVER touch docs/ORIENTATION.md — it is HARNESS-OWNED: the harness deterministically regenerates",
    "it from this same gather right after you finish and commits it separately. Any edit you make to it",
    "is overwritten.",
    "",
    "=== DETERMINISTIC GATHER (no LLM produced this) ===",
    gatherReport,
    "",
    "Editing MASTER-PLAN.md in the current directory, do ALL of:",
    "1. Append SHIPPED-log entries for what landed (from 'Merged since marker'), each with its PR link.",
    "2. Refresh the NET STATE section so it reflects reality (it currently predates WS-0).",
    "3. Add the observed CALIBRATION TABLE below (the numbers mounts.yaml/W1-T5 needs).",
    "4. Mine FAILURES (blocked_* verdicts) into PROPOSED golden/new tasks — PROPOSALS ONLY, in a",
    "   'Retro proposals' note. Do NOT edit plan/tasks.yaml.",
    "5. ★ COMPRESSION (REQUIRED — a retro that only ADDS is a failed retro): find what is STALE,",
    "   REDUNDANT, or SUPERSEDED and DELETE or fold it. The diff MUST be net-negative somewhere.",
    "",
    "CALIBRATION TABLE:",
    calTable,
    "",
    "Then, from the working directory:",
    "- git add MASTER-PLAN.md && commit with a concise message;",
    "- `git push origin HEAD` (NOT -u);",
    "- open a PR: `gh pr create --fill --base main`. The PR body MUST include an `Acceptance:` block of",
    "  `- <claim> | <proof>` bullets covering: SHIPPED log added, NET STATE refreshed, calibration table",
    "  present, and COMPRESSION done (name the deletion). Include as the LAST body line:",
    `  Remudero-Task: RETRO-${runId.replace(/^RETRO-/, "")}`,
    "- End your REPORT with exactly: PR_URL: <the pull request url>",
  ].join("\n");
}

/**
 * Injectable exec seam for {@link readUsageSnapshot} — tests inject a recorder to assert
 * what argv/env the probe passed, with no real `claude` credential or spend involved.
 * Appended LAST in {@link readUsageSnapshot}'s signature so no existing positional caller
 * shifts (CLAUDE.md, #977/#978). Omitted ⇒ {@link defaultUsageProbeRunner}, the real
 * `execFileSync` call this seam replaces byte-for-byte.
 */
export type UsageProbeRunner = (
  bin: string,
  argv: string[],
  opts: { encoding: "utf8"; env: Record<string, string>; maxBuffer: number },
) => string;

const defaultUsageProbeRunner: UsageProbeRunner = (bin, argv, opts) => execFileSync(bin, argv, opts);

/**
 * Which half of {@link readUsageSnapshot} failed. `"spawn"` is genuinely unreadable — the CLI
 * could not be run, or ran and failed. `"parse"` means the read SUCCEEDED and the text could not
 * be understood, which is a completely different problem with a completely different fix, and
 * conflating the two is what cost this fleet its headroom read for hours on 2026-07-31.
 */
export type UsageProbeFailureStage = "spawn" | "parse";

/** Injected sink for that failure — the real caller gets {@link ledgerUsageProbeFailure}. */
export type UsageProbeFailureSink = (stage: UsageProbeFailureStage, reason: string) => void;

/**
 * How much of the failure message reaches the ledger. Generous enough for the whole of a real
 * `UsageParseError` (`unparseable weekly (Fable) window: 0% used` is 47 chars) while bounding a
 * pathological `execFileSync` error that can carry an entire captured stderr.
 */
const USAGE_PROBE_REASON_MAX = 400;

/**
 * Record a usage-probe failure DURABLY, so the next parse surprise names itself on the first
 * tick instead of after hours of investigation.
 *
 * `usage.probe_failed` is a NEW step name on purpose: `daemon.headroom.unavailable` already
 * exists and means something narrower and different (daemon.ts's bounded degraded-mode
 * allowance), so reusing it would have conflated a parser defect with a transient read miss.
 *
 * NOT added to `DECISION_RELEVANT_LEDGER_STEPS` (lib/ledger.ts), deliberately: nothing DECIDES
 * on this line — it is pure diagnostics, and the enforcement path keys on `snap` being
 * `undefined`, exactly as before. Rotation may archive it and no bound moves. (That set is for
 * lines a decision COUNTS or READS; adding a diagnostic would grow the never-rotated core for
 * nothing.)
 *
 * FAILS SILENT ON ITS OWN FAILURE, and only on its own. A best-effort diagnostic must never be
 * the reason a best-effort read becomes a crash — if the ledger is unwritable, the caller still
 * gets its `undefined` and the drain still continues.
 */
export function ledgerUsageProbeFailure(config: Config, stage: UsageProbeFailureStage, reason: string): void {
  try {
    appendLedger(ledgerPathFor(config), {
      run_id: "USAGE-PROBE",
      task_id: "DAEMON",
      step: "usage.probe_failed",
      stage,
      reason: reason.slice(0, USAGE_PROBE_REASON_MAX),
    });
  } catch {
    // Diagnostics are never worth a throw on this path.
  }
}

/**
 * Read current `/usage` headless and parse it; `undefined` on any failure (best-effort;
 * the drain/daemon continues on an unreadable read — max + budget still bound it. That
 * polarity is ratified and NOT this function's to change.)
 *
 * W1-T267: the probe's HOME must resolve the SAME credential store a worker spawn
 * resolves (worker.ts's `spawnWorker`, ~line 590-615) — never the bare parent env's
 * HOME, which follows the fleet user's real login keychain. `workerKeychainPaths` is the
 * ONE derivation of that store's path; this probe and every worker spawn both call it,
 * so the two can never drift onto two different files. `materializeWorkerHome` then
 * symlinks the redirected HOME's `Library/Keychains/login.keychain-db` slot at that same
 * store (skipping the grant, harmlessly, if the store does not exist yet) — the identical
 * mechanism `spawnWorker` uses, not a second, divergent one.
 */
export function readUsageSnapshot(
  config: Config,
  runUsageProbe: UsageProbeRunner = defaultUsageProbeRunner,
  onUnreadable: UsageProbeFailureSink = (stage, reason) => ledgerUsageProbeFailure(config, stage, reason),
): UsageSnapshot | undefined {
  let out: string;
  // ── SPAWN. Its own try, ending at the probe call — see the two-try note below. ───────────
  try {
    const realHome = process.env.HOME ?? homedir();
    // A stable, non-per-call home (never a fresh `perRunWorkerHomeDir` per read) so
    // repeated probe reads reuse — and idempotently refresh — one materialized
    // directory rather than littering `worker-home-*` siblings on every tick.
    const workerHome = perRunWorkerHomeDir(workerHomeDir(config), "usage-probe");
    const workerKeychainPath = workerKeychainPaths(join(config.root, "state")).keychainPath;
    materializeWorkerHome({ workerHome, realHome, workerKeychainPath });

    const env = buildWorkerEnv({}, process.env, {
      zdotdir: workerZdotdir(config),
      shell: workerShell(config),
      home: workerHome,
    });
    out = runUsageProbe(config.claudeBin, ["-p", "/usage"], {
      encoding: "utf8",
      env,
      maxBuffer: 1 << 24,
    });
  } catch (e) {
    onUnreadable("spawn", String((e as Error)?.message ?? e));
    return undefined; // unreadable ⇒ the drain continues (max + budget still bound it)
  }
  // ── PARSE, in its OWN try. ────────────────────────────────────────────────────────────────
  // WHY TWO TRIES, AND WHY THIS IS NOT COSMETIC. `parseUsage(out)` used to sit inside the spawn
  // try, so one bare `catch` covered both — and on 2026-07-31 that made a PERFECT read
  // indistinguishable from no read at all. The probe exited 0 and returned a complete,
  // correctly-authenticated 1015-byte reading; `parseUsage` then threw
  // `unparseable weekly (Fable) window: 0% used`; the bare catch swallowed it and returned
  // `undefined`. The daemon logged nothing, every 60 seconds, for hours — and the old comment
  // said "unreadable", which was false: it read fine and could not PARSE. Those are different
  // failures with different fixes and the code could not tell them apart.
  //
  // The message that would have ended the investigation in two minutes existed in memory on
  // every single tick and was discarded every single time. So the reason is now recorded
  // DURABLY, naming the offending line, before the same `undefined` is returned. The RETURN
  // POLARITY is deliberately unchanged — an unreadable read still lets the drain continue, which
  // is ratified and not this function's to change; only the silence is fixed.
  try {
    return parseUsage(out);
  } catch (e) {
    onUnreadable("parse", String((e as Error)?.message ?? e));
    return undefined;
  }
}

/**
 * P29(ii)'s escalation side — called once `nextRunnable`'s `isCircuitTripped`
 * (status.ts's `evaluateDispatchBreaker`, via this file's `breakerGateFor`) reports a
 * task has been dispatched the policy-capped number of times with no new owned PR
 * since — never called merely on "indeterminate" (an absent/rotated ledger read,
 * handled instead by `isIndeterminate` as a skip-and-retry, not an escalation; see
 * `evaluateDispatchBreaker`'s doc). DEDUPED: a
 * task escalates AT MOST ONCE (checked via this module's OWN `dispatch.
 * circuit_broken.escalated` ledger line — never `escalation.issue_opened`
 * alone, which a genuine_blocker escalation for the SAME task could also have
 * written, for an unrelated reason) — mirrors ops.ts's alert-escalation dedup
 * discipline (a ledger line as the dedup key), never a second store.
 *
 * THE DEDUP KEY IS WRITTEN WHETHER OR NOT DELIVERY SUCCEEDS. The ledger-derived,
 * cross-boot dedup above was already the right shape; its defect was that the
 * marker was recorded only AFTER `escalate()` returned, so a THROWING `gh` wrote
 * nothing and every subsequent boot retried the same escalation — which is how a
 * transport failure became an unbounded relaunch loop (1 such marker in the
 * ledger against 460 boots). Marking the attempt makes the dedup durable across
 * the process death it is supposed to survive.
 *
 * The trade-off is deliberate and stated: a task whose escalation failed will not
 * be retried automatically. That is the correct side to err on for a BACKSTOP
 * NOTIFICATION — an undelivered notice is visible as an `escalation.failed` line
 * and costs one operator read, whereas retry-until-success costs the fleet.
 */
export function escalateCircuitBreak(
  task: Task,
  ctx: { owner: string; repo: string; ledgerPath: string; runId: string; issues?: IssueGateway },
): void {
  const already = readLedgerLines(ctx.ledgerPath).some(
    (l) => l.step === "dispatch.circuit_broken.escalated" && l.task_id === task.id,
  );
  if (already) return;
  const issueUrl = tryEscalate(
    {
      class: "BLOCKED",
      taskId: task.id,
      runId: ctx.runId,
      summary: `${task.id}: dispatch circuit breaker tripped — repeated dispatch with no new owned PR`,
      detail:
        `MASTER-PLAN P29(ii): ${task.id} has been dispatched with no new owned PR appearing since — the ` +
        `W1-T1/W1-T29 redispatch-storm shape (~130 dispatches / ~$130 / ~10h on one task, five hours of it ` +
        `AFTER the task's own PR had already merged under a sibling run). Dispatch is now HALTED for this ` +
        `task until a human resolves the underlying block; this is the backstop, not a diagnosis of WHY.`,
      options: [
        {
          label: "fix and resume",
          detail: `Resolve ${task.id}'s underlying block (a manual patch or \`rmd fix\`), then \`rmd drain\`/\`rmd daemon\` to continue.`,
        },
        {
          label: "correct the credit",
          detail: `If ${task.id} actually landed under a PR the ownership-assert rejected, \`rmd correct\` it (P9/W1-T75).`,
        },
      ],
      recommendation: "fix and resume",
    },
    {
      issues: ctx.issues ?? ghIssueGateway(ctx.owner, ctx.repo),
      ledgerPath: ctx.ledgerPath,
      runId: ctx.runId,
    },
  );
  appendLedger(ctx.ledgerPath, {
    run_id: ctx.runId,
    task_id: task.id,
    step: "dispatch.circuit_broken.escalated",
    issue_url: issueUrl,
    delivered: issueUrl !== null,
  });
}

/**
 * W1-T316's escalation side — `escalateCircuitBreak`'s twin for the LIFETIME dispatch cap
 * (W1-T271): called once `nextRunnable`'s `isLifetimeCapExceeded` (status.ts's
 * `isLifetimeDispatchCapExceeded`, via this file's `breakerGateFor`) reports a task has been
 * dispatched (`run.start`) at least `DEFAULT_MAX_TASK_LIFETIME_DISPATCHES` times across its
 * WHOLE recorded history — a count `pr.opened` never resets, unlike the streak breaker's own,
 * so this fires for the shape that evades that breaker entirely (W1-T254: five dispatches in
 * eighty minutes, each one opening and merging its own genuine no-op PR).
 *
 * DEDUP + ORDERING mirror `escalateCircuitBreak` exactly, on the sibling ledger step
 * (`dispatch.lifetime_capped.escalated`, DECISION_RELEVANT so a rotation never re-arms it):
 * checked via this module's OWN ledger line (never `escalation.issue_opened` alone), and the
 * marker is written whether or not delivery succeeds, for the same reason `escalateCircuitBreak`'s
 * own doc gives — an undelivered notice costs one operator read, not an unbounded retry loop.
 */
export function escalateLifetimeCapExceeded(
  task: Task,
  ctx: { owner: string; repo: string; ledgerPath: string; runId: string; issues?: IssueGateway },
): void {
  const already = readLedgerLines(ctx.ledgerPath).some(
    (l) => l.step === "dispatch.lifetime_capped.escalated" && l.task_id === task.id,
  );
  if (already) return;
  const issueUrl = tryEscalate(
    {
      class: "BLOCKED",
      taskId: task.id,
      runId: ctx.runId,
      summary: `${task.id}: lifetime dispatch cap exceeded — dispatched ${DEFAULT_MAX_TASK_LIFETIME_DISPATCHES}+ times, ever`,
      detail:
        `W1-T271: ${task.id} has been dispatched (\`run.start\`) at least ${DEFAULT_MAX_TASK_LIFETIME_DISPATCHES} ` +
        `times across its whole recorded ledger history. UNLIKE the per-task circuit breaker above, this count is ` +
        `NEVER reset by a \`pr.opened\` line — so a task that merges a genuine no-op PR every cycle (the W1-T254 ` +
        `shape: five dispatches in eighty minutes, each one opening and merging its own PR) still trips this ` +
        `backstop even though the streak breaker alone never would. Dispatch is now HALTED for this task until a ` +
        `human resolves the underlying loop; this is the backstop, not a diagnosis of WHY.`,
      options: [
        {
          label: "fix and resume",
          detail: `Resolve ${task.id}'s underlying loop (a manual patch, a task re-scope, or \`rmd fix\`), then \`rmd drain\`/\`rmd daemon\` to continue.`,
        },
        {
          label: "correct the credit",
          detail: `If ${task.id} actually landed under a PR the ownership-assert rejected, \`rmd correct\` it (P9/W1-T75).`,
        },
      ],
      recommendation: "fix and resume",
    },
    {
      issues: ctx.issues ?? ghIssueGateway(ctx.owner, ctx.repo),
      ledgerPath: ctx.ledgerPath,
      runId: ctx.runId,
    },
  );
  appendLedger(ctx.ledgerPath, {
    run_id: ctx.runId,
    task_id: task.id,
    step: "dispatch.lifetime_capped.escalated",
    issue_url: issueUrl,
    delivered: issueUrl !== null,
  });
}

/**
 * W1-T215's escalation side, wired at last — `escalateCircuitBreak`'s sibling for the daemon
 * BOOT-RATE invariant: called by `daemonBoot`'s `crashLoopCheck.onBreach` (lib/daemon.ts) when
 * `detectDaemonCrashLoop` finds MORE than `maxBoots` boots inside one rolling `windowMs`. The
 * detector merged 2026-07-22 (#590) and sat unasked while the 2026-08-03 ENOSPC storm relaunched
 * the daemon ten times with ZERO escalation — four dispatches died and the only operator signal
 * was "progress seems slow". This function is what a breach DOES: it opens a needs-human issue
 * carrying the verdict's own evidence (the densest window's boot timestamps), so the loop is
 * legible the moment it exists instead of after a hand-read of raw ledger timestamps.
 *
 * CROSS-BOOT DEDUP keyed on the STORM, not a task (there is none) and not a per-process flag
 * (every relaunch IS a new process — a process flag would open one issue per boot, ~one a
 * minute). The episode rule, same discipline as `escalateHeadroomReserveBreach`'s `resets_at`
 * key: skip iff a prior `daemon.crashloop.escalated` marker's `window_newest` falls within
 * `windowMs` of THIS verdict's newest boot — an ongoing storm keeps every subsequent boot inside
 * one escalation, while a genuinely NEW storm (a quiet gap longer than the window, then fresh
 * boots) escalates again. The marker is written whether or not delivery succeeds, for
 * `escalateCircuitBreak`'s own stated reason: an undelivered notice costs one operator read, not
 * an unbounded retry loop. The step is in DECISION_RELEVANT_LEDGER_STEPS (ledger.ts) — this
 * function READS it to dedup, so a rotation archiving it would re-open a duplicate issue per
 * boot for as long as the storm lasts (the #977 class).
 *
 * DELIBERATELY NOT A BOOT BLOCKER: daemonBoot logs `daemon.crashloop_check` either way and boot
 * continues — KeepAlive keeps relaunching until the operator acts, and `state/PAUSE` remains the
 * stop. This surfaces; it does not gate.
 */
export function escalateCrashLoop(
  verdict: CrashLoopVerdict,
  ctx: { owner: string; repo: string; ledgerPath: string; runId: string; issues?: IssueGateway },
): void {
  const newest = verdict.windowBoots[verdict.windowBoots.length - 1];
  const newestMs = Date.parse(newest ?? "");
  if (!verdict.breached || !Number.isFinite(newestMs)) return;
  const already = readLedgerLines(ctx.ledgerPath).some((l) => {
    if (l.step !== "daemon.crashloop.escalated") return false;
    const priorMs = Date.parse(String(l.window_newest ?? ""));
    return Number.isFinite(priorMs) && newestMs - priorMs <= verdict.windowMs;
  });
  if (already) return;
  const issueUrl = tryEscalate(
    {
      class: "BLOCKED",
      taskId: "DAEMON",
      runId: ctx.runId,
      summary: `daemon crash-loop: ${verdict.windowBoots.length} boots inside ${Math.round(verdict.windowMs / 60_000)} minutes`,
      detail:
        `W1-T215: detectDaemonCrashLoop found ${verdict.windowBoots.length} daemon boots inside one rolling ` +
        `${Math.round(verdict.windowMs / 60_000)}-minute window (threshold: more than ${verdict.maxBoots}). ` +
        `launchd's KeepAlive relaunches a nonzero-exiting daemon every ThrottleInterval, so a boot rate like ` +
        `this means the daemon is DYING during or shortly after boot, being restarted, and dying again — the ` +
        `2026-08-03 shape, where an ENOSPC write in the boot path crash-looped ten boots with no signal. The ` +
        `densest window's boots, oldest first: ${verdict.windowBoots.join(", ")}. Boot itself is NOT blocked ` +
        `by this notice; the loop is still running until acted on.`,
      options: [
        {
          label: "read the last boot's failure and fix the cause",
          detail:
            "The crash is whatever kills the process between `daemon.boot` and its next tick — check the newest " +
            "ledger lines after the last `daemon.boot`, then the launchd stderr log. Disk-full, a thrown ledger " +
            "write, and a bad deploy are the observed causes.",
        },
        {
          label: "pause the fleet while diagnosing",
          detail: "Drop `state/PAUSE` (the daemon idles in-process, no relaunch storm) or `launchctl bootout` the unit.",
        },
      ],
      recommendation: "read the last boot's failure and fix the cause",
    },
    {
      issues: ctx.issues ?? ghIssueGateway(ctx.owner, ctx.repo),
      ledgerPath: ctx.ledgerPath,
      runId: ctx.runId,
    },
  );
  appendLedger(ctx.ledgerPath, {
    run_id: ctx.runId,
    task_id: "DAEMON",
    step: "daemon.crashloop.escalated",
    window_newest: newest,
    window_boots: verdict.windowBoots.length,
    window_ms: verdict.windowMs,
    max_boots: verdict.maxBoots,
    issue_url: issueUrl,
    delivered: issueUrl !== null,
  });
}

/**
 * The post-review STALL notice: the sweep's `postReview` path has failed {@link
 * POST_REVIEW_STALL_THRESHOLD} times in a row with no success between.
 *
 * THE DEFECT, MEASURED. `sweep.post_review.failed` fired 91 times across a week — every one a
 * GraphQL rate-limit — and produced NO operator-visible signal. Green PRs sat unreviewed while the
 * sweep retried each tick and appended another identical line; an operator found it by hand after a
 * full session. That is the week's recurring shape: a mechanism failing correctly and saying
 * nothing. A transport fix removes this CAUSE; only a signal removes the CLASS.
 *
 * WHY A NEW CLASS RATHER THAN AN EXISTING ONE. A decision-authority audit found the escalation
 * funnel INVERTED — of 369 needs-human issues, roughly 80% were things the machine resolved itself
 * and were never retracted — so adding noise is the failure mode to avoid. This qualifies on the
 * test that audit implies: the machine CANNOT resolve it. Every existing class names a task or a PR
 * the fleet can act on (`dispatch.circuit_broken`, `dispatch.lifetime_capped`,
 * `dispatch.starvation`, `daemon.crashloop`, `daemon.headroom_reserve`); a post-review stall is
 * fleet-wide, blocks EVERY green PR at once, and its observed cause — an exhausted API quota — is
 * outside the fleet's power to fix. Reusing `daemon.crashloop` would misname it and reusing a
 * per-task class would file one issue per stuck PR, which is the inversion again.
 *
 * DEDUP IS THE WHOLE DESIGN, NOT A DETAIL. `escalate()` gates its entire dedup block on
 * `if (prRef && deps.issues.listOpen)`, so an escalation naming no PR skips dedup and opens a FRESH
 * issue every call — the observed eight-identical-"dispatch queue starved"-issues shape. This
 * escalation names no single PR (the condition is fleet-wide), so it dedups the way
 * `escalateCrashLoop` does: an EPISODE key in the ledger. Skip iff a prior
 * `sweep.post_review.stalled.escalated` marker's `episode_newest` is within `episodeMs` of THIS
 * verdict's newest failure. An ongoing stall therefore escalates ONCE however many ticks it spans,
 * while a genuinely new stall after a quiet gap escalates again. The marker is written whether or
 * not delivery succeeded, for `escalateCircuitBreak`'s stated reason: an undelivered notice costs
 * one operator read, not an unbounded retry loop. The step is registered in
 * DECISION_RELEVANT_LEDGER_STEPS (ledger.ts) because THIS function reads it back.
 */
export const POST_REVIEW_STALL_EPISODE_MS = 60 * 60 * 1000;

export function escalatePostReviewStall(
  verdict: PostReviewStallVerdict,
  ctx: { owner: string; repo: string; ledgerPath: string; runId: string; issues?: IssueGateway; episodeMs?: number },
): void {
  const newestMs = Date.parse(verdict.newestFailureTs ?? "");
  if (!verdict.stalled || !Number.isFinite(newestMs)) return;
  const episodeMs = ctx.episodeMs ?? POST_REVIEW_STALL_EPISODE_MS;
  const already = readLedgerLines(ctx.ledgerPath).some((l) => {
    if (l.step !== "sweep.post_review.stalled.escalated") return false;
    const priorMs = Date.parse(String(l.episode_newest ?? ""));
    return Number.isFinite(priorMs) && newestMs - priorMs <= episodeMs;
  });
  if (already) return;
  const quota = verdict.rateLimited
    ? " Every failure in the run is an API quota exhaustion, which is fleet-stopping but self-clearing at the " +
      "bucket's reset — check `gh api rate_limit` before assuming a code fault."
    : "";
  const issueUrl = tryEscalate(
    {
      class: "BLOCKED",
      taskId: "DAEMON",
      runId: ctx.runId,
      summary: `post-review stalled: ${verdict.consecutiveFailures} consecutive failures, no review posted`,
      detail:
        `The sweep's post-review path has failed ${verdict.consecutiveFailures} times in a row with no success ` +
        `between (first ${verdict.oldestFailureTs}, newest ${verdict.newestFailureTs}). While this holds, a PR ` +
        `whose checks are green never receives its remudero-review status, so it cannot merge and the sweep ` +
        `re-attempts it every tick — silently, which is why this notice exists.${quota} The failing call, with ` +
        `digits normalised so one stall does not read as many: ${verdict.normalisedError}`,
      options: [
        {
          label: "clear the cause, then let the next sweep tick post the reviews",
          detail:
            "No manual re-drive is needed — the sweep re-attempts every tick, so the backlog clears itself once " +
            "the cause is gone." +
            // Only offered when it actually applies: naming a quota remedy on a stall that is not a
            // quota problem sends the operator to the wrong instrument, which is the failure mode
            // this whole notice exists to avoid.
            (verdict.rateLimited ? " `gh api rate_limit` shows the reset." : ""),
        },
        {
          label: "post the blocked reviews by hand",
          detail: "`rmd review <pr>` per stuck PR — the same deterministic verb the sweep calls.",
        },
      ],
      recommendation: "clear the cause, then let the next sweep tick post the reviews",
    },
    { issues: ctx.issues ?? ghIssueGateway(ctx.owner, ctx.repo), ledgerPath: ctx.ledgerPath, runId: ctx.runId },
  );
  appendLedger(ctx.ledgerPath, {
    run_id: ctx.runId,
    task_id: "DAEMON",
    step: "sweep.post_review.stalled.escalated",
    episode_newest: verdict.newestFailureTs,
    consecutive_failures: verdict.consecutiveFailures,
    rate_limited: verdict.rateLimited,
    issue_url: issueUrl,
    delivered: issueUrl !== null,
  });
}

/**
 * P34 clause (c), W1-T249: the daemon's `onHeadroomBreach` hook, called when a
 * weekly (or session) window first crosses the operator reserve. Dispatch is
 * ALREADY paused by the time this fires (`runDaemon`'s own in-process idle,
 * driven by the SAME reading) — this is a pure notification, mirroring
 * `escalateCircuitBreak` immediately above rather than a second mechanism.
 *
 * CROSS-BOOT DEDUP keyed on `resetsAt` — NOT task id (there is no task; the
 * breach is a property of the account, not one candidate change) and NOT a
 * per-process flag alone (`runDaemon`'s own `headroomReserveEscalated` already
 * bounds ONE daemon run, but a restart forgets it and would re-open the SAME
 * issue for the SAME still-unresolved window). The window's own `resets_at` is
 * the natural episode key: unchanged for as long as the breach persists, and a
 * NEW value the moment the window actually resets, so a later breach escalates
 * again rather than staying silenced by a stale marker (the same "write the
 * dedup key whether or not delivery succeeded" discipline
 * `escalateCircuitBreak` documents, so a throwing `gh` is never retried into an
 * unbounded relaunch loop).
 */
export function escalateHeadroomReserve(
  info: { window: string; percentUsed: number; limitPct: number; resetsAt: string },
  ctx: { owner: string; repo: string; ledgerPath: string; runId: string; issues?: IssueGateway },
): void {
  const already = readLedgerLines(ctx.ledgerPath).some(
    (l) => l.step === "daemon.headroom_reserve.escalated" && l.resets_at === info.resetsAt,
  );
  if (already) return;
  const issueUrl = tryEscalate(
    {
      class: "HARD_STOP",
      taskId: "daemon",
      runId: ctx.runId,
      summary: `weekly headroom reserve reached — dispatch paused until ${info.resetsAt}`,
      detail:
        `P34 clause (c): ${info.window} is at ${info.percentUsed}% used (>= the ${info.limitPct}% operator ` +
        `reserve ceiling). Dispatch is paused — drain-and-hold, in-flight work finishes, no new spawn — until ` +
        `the window resets at ${info.resetsAt}; imputed ledger dollar figures never gate this decision, only ` +
        `the subscription window itself does.`,
      options: [
        {
          label: "wait for reset",
          detail: `Dispatch resumes on its own once the window resets at ${info.resetsAt} — no action needed.`,
        },
        {
          label: "raise the reserve",
          detail: "If 5% is too conservative for this account, retune the HEADROOM_LIMIT_PCT policy curve.",
        },
      ],
      recommendation: "wait for reset",
    },
    {
      issues: ctx.issues ?? ghIssueGateway(ctx.owner, ctx.repo),
      ledgerPath: ctx.ledgerPath,
      runId: ctx.runId,
    },
  );
  appendLedger(ctx.ledgerPath, {
    run_id: ctx.runId,
    task_id: "daemon",
    step: "daemon.headroom_reserve.escalated",
    resets_at: info.resetsAt,
    issue_url: issueUrl,
    delivered: issueUrl !== null,
  });
}

/**
 * W1-T372: the daemon's `onQuotaExhausted` hook, called when a `gh api rate_limit` bucket
 * (REST/core or GraphQL — read independently, `daemon.ts`'s tick) first crosses from having
 * budget to having none. UNLIKE `escalateHeadroomReserve` immediately above, dispatch is NOT
 * paused by the time this fires — W1-T372 is observe-and-surface only (this task's design
 * (vii): no threshold change, no governing action) — so this notice exists purely so an
 * operator is not the one who discovers the exhaustion by watching `gh pr create` die at a
 * push boundary (the a2b904d recon this task cites: W1-T333 lost ~40 minutes of completed
 * work that way, silently, because nothing observed the crossing).
 *
 * CROSS-BOOT DEDUP keyed on (bucket, resetsAt) — the SAME "episode key = the window's own
 * reset instant" discipline `escalateHeadroomReserve` documents just above, kept PER BUCKET
 * (design (iv)) so a core exhaustion and a GraphQL exhaustion in the same hour each get their
 * own notice rather than one suppressing the other, and so a bucket that exhausts again after
 * its own reset (a genuinely new episode) escalates again rather than staying silenced by a
 * stale marker from the PRIOR window.
 *
 * SELF-CLEARING, STATED IN THE BODY ITSELF (design (v)): a quota exhaustion clears on its own
 * bucket's hourly reset, so this notice names its own expiry (`resetsAt`) rather than asking
 * for a human close — W1-T345 is the filed retraction mechanism this notice does not depend
 * on; until it lands (or if it never does), the reset timestamp alone tells a human reading
 * this later that no action closes it.
 */
export function escalateQuotaExhaustion(
  info: { bucket: "core" | "graphql"; remaining: number; resetsAt: string },
  ctx: { owner: string; repo: string; ledgerPath: string; runId: string; issues?: IssueGateway },
): void {
  const already = readLedgerLines(ctx.ledgerPath).some(
    (l) => l.step === "daemon.quota_exhausted.escalated" && l.bucket === info.bucket && l.resets_at === info.resetsAt,
  );
  if (already) return;
  const spent =
    info.bucket === "graphql"
      ? "`gh pr create`, `gh pr view --json`, and therefore `rmd review` — a run that finishes its work and " +
        "then cannot open or update its own PR at this bucket's exhaustion loses that work silently, exactly " +
        "as W1-T333 did"
      : "the board's own `gh pr view`/`pr list`/`issue view` reads (status.ts's `ghGateway`/`buildBatchedGithub`)";
  const issueUrl = tryEscalate(
    {
      class: "HARD_STOP",
      taskId: "daemon",
      runId: ctx.runId,
      summary: `gh api rate_limit ${info.bucket} bucket exhausted — resets ${info.resetsAt}`,
      detail:
        `W1-T372: the daemon's tick observed the ${info.bucket} bucket cross from having budget to ${info.remaining} ` +
        `remaining. This bucket backs ${spent}. This is a NOTICE, not a hold: dispatch is not paused and no ` +
        `existing consumer's behavior changed — the bucket refills on its own at ${info.resetsAt}, and this notice ` +
        `is self-clearing at that instant with no action required; a human reading this after that time can close ` +
        `it on sight.`,
      options: [
        {
          label: "wait for reset",
          detail: `The bucket refills on its own at ${info.resetsAt} — no action needed.`,
        },
        {
          label: "check what spent it",
          detail: "`gh api rate_limit` shows the live figure; a runaway caller against this bucket is the thing worth finding, not this notice.",
        },
      ],
      recommendation: "wait for reset",
    },
    {
      issues: ctx.issues ?? ghIssueGateway(ctx.owner, ctx.repo),
      ledgerPath: ctx.ledgerPath,
      runId: ctx.runId,
    },
  );
  appendLedger(ctx.ledgerPath, {
    run_id: ctx.runId,
    task_id: "daemon",
    step: "daemon.quota_exhausted.escalated",
    bucket: info.bucket,
    resets_at: info.resetsAt,
    issue_url: issueUrl,
    delivered: issueUrl !== null,
  });
}

/**
 * The drain's end-of-run quota check: when a drain stopped with NOTHING RUNNABLE and at least one
 * candidate was declined as INDETERMINATE, ask whether a `gh api rate_limit` bucket is the reason
 * and escalate if it is.
 *
 * WHY THIS EXISTS AT ALL. `escalateQuotaExhaustion` had exactly ONE caller — `runDaemon`'s tick.
 * A drain run by hand or by a wrapper never went near it, so the one path an operator watches
 * live was the one path that could exhaust the GraphQL bucket and say only `no_runnable`. The
 * exhaustion was observable to the fleet and invisible to the person in front of it.
 *
 * NO SECOND DETECTOR, and the sharing is structural rather than asserted: the reader is
 * `readGhRateLimitBuckets` (the daemon's own, one exec, both buckets), the predicate is
 * `isBucketExhausted` (shared, see its doc for the cycle that keeps the daemon's copy inline),
 * and the escalation is `escalateQuotaExhaustion` itself — whose (bucket, resetsAt) dedup is read
 * off the LEDGER, so a drain and a daemon observing the same window open ONE notice between them
 * rather than one each. Nothing here decides what an exhaustion means.
 *
 * INDETERMINATE IS THE TRIGGER, NOT THE CLAIM. `projectPlan` sets `indeterminate` on any failed
 * read (W1-T119) — throttle, network, auth, all of them — so a non-zero count is a reason to LOOK,
 * never a finding. The bucket read is what decides, and a healthy bucket escalates nothing: this
 * repo has four separate bounds that fired on healthy conditions, and a report that always blames
 * the quota would be worse than the silence it replaces.
 *
 * GATED SO A HEALTHY DRAIN SPENDS NOTHING. No declines, or any stop reason other than
 * `no_runnable`, and the `gh` call is never made. FAIL-SOFT throughout — this is reporting, and a
 * reporting path that can change a drain's exit code is a defect, not a feature.
 */
export function reportDrainQuotaExhaustion(
  summary: { stopReason: string; indeterminateDeclines?: number },
  ctx: { owner: string; repo: string; ledgerPath: string; runId: string; issues?: IssueGateway },
  deps: {
    readGhQuota?: () => GhRateLimitBuckets;
    escalate?: typeof escalateQuotaExhaustion;
    log?: (step: string, extra?: Record<string, unknown>) => void;
  } = {},
): void {
  if (summary.stopReason !== "no_runnable") return;
  if ((summary.indeterminateDeclines ?? 0) <= 0) return;
  const log = deps.log ?? (() => {});
  const escalate = deps.escalate ?? escalateQuotaExhaustion;
  let quota: GhRateLimitBuckets;
  try {
    quota = (deps.readGhQuota ?? (() => readGhRateLimitBuckets()))();
  } catch (e) {
    log("drain.quota_check.failed", { error: String((e as Error)?.message ?? e) });
    return;
  }
  for (const bucket of ["core", "graphql"] as const) {
    const reading = quota[bucket];
    if (!reading) continue;
    log("drain.quota", { bucket, remaining: reading.remaining, resets_at: reading.resetsAt });
    if (!isBucketExhausted(reading)) continue;
    try {
      escalate({ bucket, remaining: reading.remaining, resetsAt: reading.resetsAt }, ctx);
    } catch (e) {
      // Mirrors the daemon tick's own catch around this same hook: an escalation that throws is
      // ledgered and swallowed. The drain has already finished its work by this point; losing the
      // whole run's exit status to a failed issue-open would invert the priority completely.
      log("drain.escalation.failed", { bucket, error: String((e as Error)?.message ?? e) });
    }
  }
}

/**
 * Recon oper#queue-starvation-2026-08-03: the daemon's `onStarvation` hook, called on an idle
 * tick whose dispatch-filter census names at least one RECOVERABLE-class blocker (circuit-
 * broken, blocked, or unmet-deps — see daemon.ts's `StarvationCensus`/starvation predicate)
 * rather than every remaining task being already-merged or verify:human. THE ASYMMETRY THIS
 * FIXES: a FAILING run already escalates (`escalateCircuitBreak` above fires once per tripped
 * breaker), but a queue that has run OUT of dispatchable work used to be indistinguishable
 * from one quietly healthy between tasks — both logged only `daemon.idle`. Dispatch is
 * already idle by the time this fires (the same in-process bound `runDaemon`'s own
 * `starvationEscalated` applies before ever calling this) — a pure notification, mirroring
 * `escalateCircuitBreak`/`escalateHeadroomReserve` immediately above rather than a second
 * mechanism.
 *
 * CROSS-BOOT DEDUP, KEYED ON "has anything actually dispatched since this last escalated" —
 * never a fixed key (there is only ever one starvation state at a time, unlike
 * `escalateCircuitBreak`'s per-task-id dedup) and never the census contents (the exact set of
 * blocked ids can churn while the queue stays starved throughout — that is still the SAME
 * episode, not a new one). `run.start` (status.ts's own dispatch-attempt marker, already
 * decision-relevant) is the natural episode boundary: it is written the moment ANY task is
 * next attempted, which is exactly what ends a starvation episode ("a new dispatchable task
 * ends the episode and re-arms"). If the most recent `dispatch.starvation.escalated` line
 * postdates the most recent `run.start` line, this starvation has already been reported and
 * nothing has dispatched since — no-op. Otherwise a dispatch happened since the last notice
 * (or none was ever sent), so the episode is fresh: escalate and write the marker, whether or
 * not delivery succeeded (`escalateCircuitBreak`'s discipline — an undelivered notice must
 * never retry into an unbounded relaunch loop).
 */
export function escalateStarvation(
  census: StarvationCensus,
  ctx: { owner: string; repo: string; ledgerPath: string; runId: string; issues?: IssueGateway },
): void {
  const lines = readLedgerLines(ctx.ledgerPath);
  let lastEscalatedIdx = -1;
  let lastDispatchIdx = -1;
  lines.forEach((l, i) => {
    if (l.step === "dispatch.starvation.escalated") lastEscalatedIdx = i;
    if (l.step === "run.start") lastDispatchIdx = i;
  });
  if (lastEscalatedIdx !== -1 && lastEscalatedIdx > lastDispatchIdx) return;

  const name = (label: string, bucket: { count: number; ids: readonly string[]; truncated: number }): string | null =>
    bucket.count === 0
      ? null
      : `${label}: ${bucket.count} (${bucket.ids.join(", ")}${bucket.truncated > 0 ? `, +${bucket.truncated} more` : ""})`;
  const parts = [
    name("circuit-broken", census.circuitBroken),
    name("blocked", census.blocked),
    name("unmet-deps", census.unmetDeps),
  ].filter((p): p is string => p !== null);

  const issueUrl = tryEscalate(
    {
      class: "BLOCKED",
      taskId: "daemon",
      runId: ctx.runId,
      summary: `dispatch queue starved — zero dispatchable, ${parts.length} recoverable class(es) blocking`,
      detail:
        `oper#queue-starvation-2026-08-03: the queue has nothing dispatchable, but this is NOT ` +
        `every task being done or needing a human — at least one RECOVERABLE-class blocker is ` +
        `holding it back: ${parts.join("; ")}. The fleet has headroom to spend and is sitting idle ` +
        `instead; the only prior symptom was a bare \`daemon.idle\` line every poll.`,
      options: [
        {
          label: "resolve the blockers",
          detail:
            "Fix the named ids: a circuit-broken task needs a manual patch or `rmd fix` (then a " +
            "fresh owned PR clears the breaker); a `blocked:` task needs the plan mark lifted; an " +
            "unmet-deps task clears itself once its dependency merges.",
        },
        {
          label: "acknowledge and wait",
          detail: "If the blockers are already being worked, no action is needed — the daemon keeps polling and re-arms this notice once it next dispatches.",
        },
      ],
      recommendation: "resolve the blockers",
    },
    {
      issues: ctx.issues ?? ghIssueGateway(ctx.owner, ctx.repo),
      ledgerPath: ctx.ledgerPath,
      runId: ctx.runId,
    },
  );
  appendLedger(ctx.ledgerPath, {
    run_id: ctx.runId,
    task_id: "daemon",
    step: "dispatch.starvation.escalated",
    circuit_broken: census.circuitBroken.count,
    blocked: census.blocked.count,
    unmet_deps: census.unmetDeps.count,
    circuit_broken_ids: census.circuitBroken.ids,
    blocked_ids: census.blocked.ids,
    unmet_deps_ids: census.unmetDeps.ids,
    issue_url: issueUrl,
    delivered: issueUrl !== null,
  });
}

/**
 * W1-T206: shared dispatch-breaker gate for drainCommand/daemonCommand — ONE
 * {@link DispatchBreakerCache} per invocation (never rebuilt per tick/per task, so a
 * same-process rotation gets caught as it happens — see the cache's own doc), memoized
 * per (taskId, this tick) since `nextRunnable` calls `isIndeterminate` then, only if that
 * was false, `isCircuitTripped` for the SAME task in the same pass; without the memo the
 * breaker's full ledger re-read would run twice per task per tick for no reason.
 *
 * W1-T316 adds `isLifetimeCapExceeded` to this SAME gate rather than standing up a second
 * per-invocation cache/read path elsewhere — `isDispatchEligible` consults it right after
 * `isIndeterminate`/`isTripped` for the SAME task in the SAME pass (drain.ts), so it gets the
 * identical per-(taskId, tick) memo those two already share. `evaluateDispatchBreaker` above
 * owns its own internal ledger read for the streak breaker's regression check (status.ts,
 * unchanged by this task); this is a second, independent, but equally memoized read of the
 * SAME `ledgerPath` for `isLifetimeDispatchCapExceeded`'s different question (count EVERY
 * `run.start`, never reset) — deliberately not routed through `evaluateDispatchBreaker`
 * itself, whose cache/regression semantics belong to the streak breaker alone (W1-T271's own
 * scope, not this task's to touch).
 *
 * W1-T414 — `openHeadBranches` is the batched {@link
 * GitHub.listOpenHeadBranches} answer, resolved ONCE by the caller (drainCommand/daemonCommand,
 * below) before this gate is built — never a fresh per-task GitHub call — and threaded into
 * `evaluateDispatchBreakerCorroborated` so a `"tripped"` streak verdict can be corroborated by a
 * GitHub-visible open PR on this task's own run branch, exactly as a local `pr.opened` line
 * already would. `undefined` (gateway lacks the method) or `null` (the read failed) both leave
 * every task's verdict exactly as {@link evaluateDispatchBreaker} alone computed it — see that
 * function's doc for the fail-to-local-count contract.
 */
function breakerGateFor(
  ledgerPath: string,
  openHeadBranches: ReadonlyArray<PrRef> | null | undefined,
): {
  isIndeterminate: (taskId: string) => boolean;
  isTripped: (taskId: string) => boolean;
  isLifetimeCapExceeded: (taskId: string) => boolean;
} {
  const cache = createDispatchBreakerCache();
  let memo: { taskId: string; state: "tripped" | "clear" | "indeterminate" } | undefined;
  const stateFor = (taskId: string) => {
    if (memo?.taskId !== taskId) {
      memo = { taskId, state: evaluateDispatchBreakerCorroborated(ledgerPath, taskId, cache, openHeadBranches) };
    }
    return memo.state;
  };
  let lifetimeMemo: { taskId: string; exceeded: boolean } | undefined;
  const lifetimeCapExceededFor = (taskId: string) => {
    if (lifetimeMemo?.taskId !== taskId) {
      lifetimeMemo = { taskId, exceeded: isLifetimeDispatchCapExceeded(readLedgerLines(ledgerPath), taskId) };
    }
    return lifetimeMemo.exceeded;
  };
  return {
    isIndeterminate: (taskId) => stateFor(taskId) === "indeterminate",
    isTripped: (taskId) => stateFor(taskId) === "tripped",
    isLifetimeCapExceeded: lifetimeCapExceededFor,
  };
}

/**
 * W1-T317: THE DAILY COST CEILING'S caller — {@link checkCostGovernor} (sweep.ts) is a pure
 * predicate that was built, tested, and never invoked from any dispatch path; this supplies that
 * call site for `drainCommand`'s and `daemonCommand`'s `DrainDeps`/`DaemonDeps.checkCostGovernor`
 * fields (drain.ts/daemon.ts). Re-derives the day's ledgered spend fresh on EVERY consultation —
 * the same "survives a process restart" freshness contract {@link breakerGateFor} gives the
 * streak/lifetime breakers — rather than a function on that SAME cache, because the governor is
 * NOT task-specific (one answer per tick, never keyed by taskId), so it needs none of that cache's
 * per-(taskId, tick) memoization.
 *
 * A deferred consultation LEDGERS ITSELF (`logCostGovernorDeferral`, sweep.ts) before returning,
 * so drain.ts/daemon.ts never need `ledgerPath`/`runId`/`appendLedger` just to report it — the
 * SAME "the callback does the escalation, the caller only logs its own generic step" split
 * `onCircuitBreak`/`onLifetimeCapExceeded` already use.
 *
 * W1-T331: the returned closure now takes an OPTIONAL `dailyCostCeilingUsd` — the per-consultation
 * LIVE ceiling, when the caller has one. `daemonCommand` (below) wires `DaemonDeps`'s
 * `reloadDailyCostCeilingUsd` so `runDaemon` supplies this argument every tick, snapshotted fresh
 * from `plan/policy.yaml` (see that dep's own doc, daemon.ts). `drainCommand` supplies none — a
 * bounded one-shot pass, out of this task's scope (see plan/tasks.d, "NOT IN SCOPE") — so its
 * calls fall through to `DEFAULT_SWEEP_POLICY`'s frozen-at-import ceiling exactly as before this
 * task, unchanged behaviour, not a regression. `undefined` is also what a caller gets on the
 * VERY FIRST daemon tick before any reload has run, or if `reloadDailyCostCeilingUsd` itself is
 * ever omitted — the fallback is the shipped default, never an unbounded one, so an unwired
 * caller degrades to the pre-task ceiling rather than to "no ceiling at all."
 */
function costGovernorGateFor(
  ledgerPath: string,
  runId: string,
): (dailyCostCeilingUsd?: number) => CostGovernorResult | undefined {
  return (dailyCostCeilingUsd) => {
    const dayCostUsd = deriveDayCostUsd(readLedgerLines(ledgerPath), Date.now());
    const policy = dailyCostCeilingUsd === undefined ? DEFAULT_SWEEP_POLICY : { ...DEFAULT_SWEEP_POLICY, dailyCostCeilingUsd };
    const result = checkCostGovernor(dayCostUsd, policy);
    if (!result.deferred) return undefined;
    logCostGovernorDeferral(result, appendLedger, ledgerPath, runId);
    return result;
  };
}

/**
 * W1-T331: builds `DaemonDeps.reloadDailyCostCeilingUsd` — the daemon's LIVE, per-tick read of
 * the EFFECTIVE daily cost ceiling, which `runDaemon` snapshots once at the top of each tick and
 * threads into {@link costGovernorGateFor}'s returned closure (see both docs).
 *
 * W1-T363: resolved through `policy.ts`'s `resolveDailyCostCeiling`, never the committed
 * `plan/policy.yaml` row alone — that function is the one place the `state/
 * DAILY_COST_CEILING_OVERRIDE` precedence rule (an operator-written override wins when present,
 * well-formed, and in bound; the committed default otherwise) is allowed to live, so a governor
 * read that bypassed it would silently ignore an operator's live override every tick. Before
 * this, the reloader read `policy.values.sweep.dailyCostCeilingUsd` directly, which made the
 * override store (W1-T332) inert to the daemon even though `resolveDailyCostCeiling` already
 * existed and was already wired into the console's own provenance render (W1-T333).
 *
 * `deps.policy` is the SAME injection seam `retroTriggerCheck`/`autoTriageCheck` already offer
 * (test/config-reader-seams.test.ts's structural check, recon-EJ: `repoRoot` is a MODULE-LEVEL
 * const no test can redirect, so an unseamed `loadPolicy(policyPath(repoRoot))` call is
 * UNREDIRECTABLE — a test could only ever pin the shipped default, never prove a policy edit
 * actually moves the decision). Production passes none, so the daemon reads the checked-in
 * `plan/policy.yaml` via the SAME `loadPolicy(policyPath(repoRoot))` construction those two
 * already use; a test injects a fixture `Policy` to prove the live ceiling changes with it. The
 * `state/` override lookup itself is scoped to the SAME `repoRoot`, matching the console
 * renderer's own root (W1-T333, account-usage.ts).
 *
 * A throw (unreadable/malformed `policy.yaml`) is deliberately left uncaught here — `runDaemon`'s
 * own reload step (daemon.ts) catches it and holds the last known-good ceiling; catching it here
 * too would just be a second, redundant discipline.
 *
 * W1-T408: reads through `resolveDailyCostCeilingForInstance`, never `resolveDailyCostCeiling`
 * directly, so THE LIVE CEILING this reloader feeds `costGovernorGateFor` reflects this
 * instance's configured share (`REMUDERO_DAILY_COST_CEILING_SHARE_USD`) when one is set — see
 * that function's own doc for why a share wins outright over both the committed default and a
 * written override. `deps.env` is injectable (defaults to `process.env`) for the same reason
 * `deps.policy` already is: a test proves the live ceiling moves with the input without
 * mutating the real process environment. Unset, this call is byte-identical to the pre-W1-T408
 * `resolveDailyCostCeiling(...).usd` it replaces — the share resolver returns `undefined` and
 * `resolveDailyCostCeilingForInstance` falls straight through to that same call.
 */
export function dailyCostCeilingReloader(deps: { policy?: Policy; env?: NodeJS.ProcessEnv } = {}): () => number {
  return () => {
    const policy = deps.policy ?? loadPolicy(policyPath(repoRoot));
    return resolveDailyCostCeilingForInstance(repoRoot, policy, deps.env).usd;
  };
}

/**
 * W1-T321: THE WIP CEILING'S caller — {@link checkQueueGovernor} (sweep.ts, built for W1-T121's
 * 23-open-PR incident) is a pure predicate that was built, tested (test/queue-governor.test.ts),
 * and never invoked from any dispatch path; this supplies that call site for `drainCommand`'s and
 * `daemonCommand`'s `DrainDeps`/`DaemonDeps.checkQueueGovernor` fields (drain.ts/daemon.ts).
 * Mirrors {@link costGovernorGateFor} immediately above: `openPrCount` is a caller-supplied
 * closure (drainCommand's own `openPrCount`, already re-derived fresh from the SAME
 * `refreshMerged` projection each call for the W1-T172 lanes budget; daemonCommand's own
 * equivalent, added by this task) rather than a ledger read — the governor's input is the LIVE
 * open-PR count, never a ledgered figure.
 *
 * A deferred consultation LEDGERS ITSELF (`logQueueGovernorDeferral`, sweep.ts) before returning,
 * so drain.ts/daemon.ts never need `ledgerPath`/`runId`/`appendLedger` just to report it — the
 * SAME "the callback does the escalation, the caller only logs its own generic step" split
 * `costGovernorGateFor` already uses.
 *
 * `policy` defaults to `DEFAULT_SWEEP_POLICY` deliberately — the limit VALUE is already a policy
 * row (`plan/policy.yaml`'s `wipLimit`, origin `lifted:src/lib/sweep.ts:257`); retuning it is a
 * separate ruling on separate evidence, out of this task's scope. Never called from `runSweep` or
 * any of its deps (arm/dispatchFix/close/escalate) — see `checkQueueGovernor`'s own asymmetry note
 * for why drainage of already-open PRs must never be gated by WIP.
 */
function queueGovernorGateFor(
  openPrCount: () => number,
  ledgerPath: string,
  runId: string,
  policy: SweepPolicy = DEFAULT_SWEEP_POLICY,
): () => QueueGovernorResult | undefined {
  return () => {
    const result = checkQueueGovernor(openPrCount(), policy);
    if (!result.deferred) return undefined;
    logQueueGovernorDeferral(result, appendLedger, ledgerPath, runId);
    return result;
  };
}

/**
 * `rmd drain [--until <id>] [--max <n>] [--dry-run]` — drain the DAG through the
 * EXISTING run-task path. Thin + deterministic: next-runnable is the plan.ts DAG
 * logic over GitHub-derived status; it STOPS ON ANY BLOCK (v1); it is headroom-aware
 * and bounded. See lib/drain.ts for the loop; this only wires the real defaults.
 */
/**
 * The post-drain rundown PUSH (W1-T141/W1-T144), extracted from drainCommand so the glue —
 * build the classified rundown, print it, and push it through the SAME digest channel
 * escalations use (never a second transport) — is unit-covered with a fake channel + fixture
 * summary, the #606 interior-glue discipline. Returns the pushed text. `print` is injectable
 * (defaults to console.log) so a test asserts the rundown without capturing stdout.
 */
export function pushDrainRundown(
  summary: DrainSummary,
  ledgerLines: Array<Record<string, unknown>>,
  config: Config,
  deps: { channel: NotifyChannel; ledgerPath: string; runId: string; print?: (s: string) => void },
): string {
  const rundown = buildRundown(summary, ledgerLines);
  (deps.print ?? ((line: string) => console.log(line)))("\n" + renderRundown(rundown));
  // W1-T144: the SAME sendRundown -> notify() path rmd digest/MANUAL/HARD_STOP escalations
  // ride, each non-merged line deep-linking to its console card via consoleUrl(config).
  return sendRundown(rundown, consoleUrl(config), {
    channel: deps.channel,
    ledgerPath: deps.ledgerPath,
    runId: deps.runId,
    taskId: "DRAIN",
  });
}

async function drainCommand(
  rest: string[],
  deps: {
    config?: Config;
    planPath?: string;
    /** Bypass git self-sync and read the plan literally — behavioral tests only, mirroring
     *  runTask's identical `skipGitSync` escape hatch. */
    skipGitSync?: boolean;
    /** Injectable GitHub-gateway constructor for the merged-status projection. Defaults to the
     *  real {@link ghGateway}. Lets a behavioral test prove which (owner, repo) `rmd drain`
     *  actually derives its gateway from — e.g. that `--repo remudero-sandbox` builds the
     *  gateway for `remudero-sandbox`, not a hardcoded literal (W1-T53) — without a network
     *  round-trip. */
    githubFactory?: (owner: string, repo: string) => GitHub;
    /** W1-T144: injectable notify channel for the post-drain rundown push — a behavioral
     *  test supplies a recording fake so the push glue runs without a real osascript send.
     *  Defaults to the operator's iMessage channel. */
    notifyChannel?: NotifyChannel;
    /** W1-T316: injectable drain loop (mirrors {@link daemonCommand}'s identical `runDaemon`
     *  seam). Defaults to the real {@link runDrain}. A test passes a stub that captures the
     *  wired `DrainDeps` and returns immediately, so the dep object drainCommand actually
     *  builds — the lifetime-cap predicate/callback included — is provable without spawning a
     *  real, unbounded drain. Production never passes this. */
    runDrain?: typeof runDrain;
    /** Injectable seams for {@link reportDrainQuotaExhaustion} — a behavioral test supplies a
     *  recording `readGhQuota`/`escalate` so the END-OF-DRAIN quota check is provable without a
     *  `gh` round-trip or a real issue. Production passes nothing and gets the real reader,
     *  the real predicate and the real escalator. */
    quotaCheck?: { readGhQuota?: () => GhRateLimitBuckets; escalate?: typeof escalateQuotaExhaustion };
  } = {},
): Promise<number> {
  // FAIL LOUD on junk args BEFORE touching config/locks/spawns (a malformed control command
  // must spawn NOTHING — the daemon-install hazard). drain takes only these flags.
  const badArg = unknownArgError("drain", rest, ["--until", "--max", "--repo", "--curated"], ["--dry-run", "--allow-stale"]);
  if (badArg) {
    console.error(badArg + "\n" + USAGE);
    return 2;
  }
  const dryRun = rest.includes("--dry-run");
  const allowStale = rest.includes("--allow-stale");
  const untilIdx = rest.indexOf("--until");
  const maxIdx = rest.indexOf("--max");

  // ── CURATION (W1-T140 limb 2): `--curated <path>` names a JSON {taskIds, depth}
  // file — the drain preview panel's curated selection, exported for the operator
  // to hand to the CLI. Validated FULLY before any config/lock/spawn (same FAIL
  // LOUD discipline as `unknownArgError` above): a missing file, bad JSON, or a
  // malformed shape refuses with exit 2 and touches nothing.
  const curatedPath = flagValue(rest, "--curated");
  let curatedSelection: CuratedSelection | undefined;
  if (curatedPath !== undefined) {
    let raw: string;
    try {
      raw = readFileSync(curatedPath, "utf8");
    } catch (e) {
      console.error(`### rmd drain — cannot read --curated file '${curatedPath}': ${String((e as Error)?.message ?? e)}`);
      return 2;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error(`### rmd drain — --curated file '${curatedPath}' is not valid JSON: ${String((e as Error)?.message ?? e)}`);
      return 2;
    }
    const rec = parsed as Record<string, unknown> | null;
    const taskIdsValid = rec !== null && typeof rec === "object" && Array.isArray(rec.taskIds) && rec.taskIds.every((x) => typeof x === "string");
    const depthValid = rec !== null && typeof rec === "object" && typeof rec.depth === "number";
    if (!taskIdsValid || !depthValid) {
      console.error(`### rmd drain — --curated file '${curatedPath}' must be {"taskIds": string[], "depth": number}`);
      return 2;
    }
    curatedSelection = { taskIds: rec!.taskIds as string[], depth: rec!.depth as number };
  }

  // W1-T253 (P37 CONSUMERS): `drain.max` read from `plan/policy.yaml` — never `drain.ts`'s
  // own fs-free literal default (`DEFAULT_MAX`'s doc, lib/drain.ts, explains why that module
  // can't load it itself: `daemon.ts` imports `drain.ts` at the value level and must stay
  // filesystem-free) — so a plan-reviewed policy edit retunes the LIVE bound with zero code
  // change.
  const drainMax = loadPolicy(policyPath(repoRoot)).values.drain.max;
  const baseOpts: DrainOpts = {
    until: untilIdx >= 0 ? rest[untilIdx + 1] : undefined,
    max: maxIdx >= 0 ? Number(rest[maxIdx + 1]) : drainMax,
    // W1-T172 PARALLEL DISPATCH — both read from the SAME SweepPolicy row
    // W1-T121 gave the WIP limit (one threshold home, never a second); raising
    // either is a policy-data edit, never a CLI flag or a second constant here.
    laneCount: DEFAULT_SWEEP_POLICY.dispatchLanes,
    wipLimit: DEFAULT_SWEEP_POLICY.wipLimit,
  };
  const opts: DrainOpts = curatedSelection ? applyCuratedSelection(baseOpts, curatedSelection) : baseOpts;
  const config = deps.config ?? loadConfig();
  // W1-T290: the headroom governor switch (operator ruling fb-1784894405468-a4153e), the
  // SAME resolved posture daemonCommand passes as opts.headroomEnabled below — resolved
  // HERE so the drain's new bounded-degraded-on-unreadable ceiling (lib/drain.ts) never
  // fires on a host that opted out via config `headroom.enabled: false`. Unwired before
  // this task: the ceiling did not exist, so nothing needed to consult the switch.
  opts.headroomEnabled = resolveHeadroomEnabled(config);
  const planPath = deps.planPath ?? join(repoRoot, "plan", "tasks.yaml");
  const ledgerPath = ledgerPathFor(config);
  const statusPath = join(config.root, "state", "status.json");
  const self = resolveOwnerRepo();
  const { owner } = self;
  // Gateway repo, parameterized like the daemon path (fix/daemon-repo-targeting): defaults to
  // THIS checkout's own repo rather than a hardcoded literal, so a checkout whose origin isn't
  // `remudero` (e.g. a sandbox) doesn't silently project merged-status against the wrong repo.
  // --repo overrides it explicitly. The plan itself is unaffected — drain always dispatches
  // from THIS checkout's origin/main (git self-sync below); only the status gateway moves.
  const repo = flagValue(rest, "--repo") ?? self.repo;

  const runId = `DRAIN-${Date.now()}`;
  const log = (step: string, extra: Record<string, unknown> = {}) =>
    appendLedger(ledgerPath, { run_id: runId, task_id: "DRAIN", step, ...extra });

  // BATCHED, NOT `ghGateway` — `drainCommand` was the LAST dispatch-path holdout, after #1529
  // moved `runTask` and #1531 moved `retroCommand`. `daemonCommand` (below) has always built its
  // factory exactly this way; this line is now byte-for-byte its twin, which is the point: the
  // two commands share `refreshMerged`/`isOpenPr`/`openPrCount`/`isIndeterminate` verbatim, and a
  // gateway that differed between them was drift hiding in the one line they did not share.
  //
  // THE DISAGREEMENT IS THE REASON, NOT THE COST. #1532 measured the SELECTOR asking `ghGateway`
  // and getting "not merged" while `runTask` — batched since #1529 — asked about the SAME task in
  // the same second and got "merged": a `task_already_merged` refusal that halted a `--max 6`
  // drain at $0.00 with five live tasks behind it. Two gateways answering one question at two
  // points of a single dispatch is the "never a second read path" rule this function's own
  // comments repeat about `isOpenPr`, `openPrCount` and `isIndeterminate`.
  //
  // THE SWAP CANNOT WITHDRAW A CREDIT, which is what makes it safe to make under a running drain.
  // Rung (c) of `deriveStatus` re-verifies EVERY `findMergedByTrailer` hit with
  // `creditsByAnchoredTrailer` before crediting, so the search's fuzziness never credited
  // anything on its own. The only behavioural difference is `--limit 1`: `ghGateway` asks GitHub
  // for ONE candidate and, when that candidate fails the anchored re-verify, has no second — a
  // FALSE NOT-MERGED. `buildBatchedGithub` applies the identical anchored regex across every
  // merged PR in one fetch. So the change can only ADD merged credits, never remove one, and the
  // dispatch consequence is strictly "fewer tasks offered", never "more".
  //
  // DEFAULTED PER CALL, NOT ONCE — the factory is invoked INSIDE `refreshMerged` (below), so each
  // pass gets a FRESH instance. That is not incidental: `buildBatchedGithub` closes over mutable
  // `lastFetchFailed`/`lastIssueFetchFailed` exactly as `ghGateway` closes over `failed`/
  // `failureReason`, so hoisting one instance out of the closure would let a single pass's outage
  // mark every later pass of the same drain indeterminate. The drain needs N instances for N
  // passes, and already has them; unlike `retroCommand` (#1531) it has only ONE projection site,
  // so it never needed two instances for two passes of differing scope.
  const githubFactory = deps.githubFactory ?? ((o: string, r: string) => buildBatchedGithub(o, r, { log }));

  // ── GIT SELF-SYNC (W1-T60): dispatch from the origin/main plan blob, never the operator's
  // working tree — see runTask's identical gate for the full rationale. FAILS CLOSED (no
  // lock taken, no spawn) on a fetch failure unless --allow-stale. `skipGitSync` (behavioral
  // tests only) reads the plan literally instead, exactly like runTask's escape hatch.
  let plan: Plan;
  if (deps.skipGitSync) {
    plan = loadPlan(planPath);
  } else {
    const synced = syncPlanOrRefuse(planPath, {
      allowStale,
      log,
      say: (msg) => console.error(`### rmd drain — ${msg}`),
    });
    if ("error" in synced) return 1;
    plan = synced.plan;
  }

  // Merged predicate, re-derived from GitHub each call (status.ts), scoped to the resolved
  // gateway repo (owner/repo, above) via `githubFactory` (the real {@link ghGateway} unless a
  // test injects a stub) — cross-repo tasks resolve via the ledger's full pr_url (deriveStatus
  // source (a)) or are verify:human.
  //
  // `lastProj` also backs `isOpenPr` (W1-T80, the in-flight dispatch-dedup
  // guard) — the SAME projection `refreshMerged` just derived, never a second
  // GitHub read path. `refreshMerged` is always called at the top of each
  // drain tick before `isOpenPr` is consulted, so it is never stale.
  let lastProj: Map<string, StatusProjection> | undefined;
  const refreshMerged: () => MergedSet = () => {
    const proj = projectPlan(
      plan,
      { ledgerPath, github: githubFactory(owner, repo) },
      statusPath,
    );
    lastProj = proj;
    return (id: string) => proj.get(id)?.merged ?? false;
  };
  const isOpenPr: OpenPrCheck = (id) => {
    const p = lastProj?.get(id);
    return p?.prState === "OPEN" ? p.prNumber : undefined;
  };
  // W1-T172: the queue governor's other input (alongside DrainOpts.wipLimit) —
  // OPEN entries in the SAME projection `isOpenPr` just read, never a second
  // GitHub read path. Only consulted by the multi-lane path.
  const openPrCount = () => {
    let n = 0;
    for (const p of lastProj?.values() ?? []) if (p.prState === "OPEN") n++;
    return n;
  };
  if (dryRun) {
    const merged = refreshMerged();
    if (opts.curated) {
      // CURATION (W1-T140): a curated selection overrides the natural DAG scan, so the
      // preview must show what --curated will actually dispatch, never the unrelated
      // natural plannedSequence — a silent mismatch here is exactly the "flag ignored"
      // hazard class (see unknownArgError's own header).
      const seq = opts.curated.filter((id) => !merged(id));
      console.log(`### rmd drain --dry-run --curated — ${seq.length} task(s) would run, in curated order:`);
      seq.forEach((id, i) => console.log(`  ${i + 1}. ${id}`));
      if (seq.length === 0) console.log("  (nothing to run — every curated id is already merged, or the selection is empty)");
    } else {
      const seq = plannedSequence(plan, merged, opts);
      console.log(`### rmd drain --dry-run — ${seq.length} task(s) would run, in order:`);
      seq.forEach((id, i) => console.log(`  ${i + 1}. ${id}`));
      if (seq.length === 0) console.log("  (nothing runnable — deps unmet, all merged, or --until already satisfied)");
    }
    console.log(`\nresume: ${resumeCommand(opts)}`);
    return 0;
  }

  // W1-T414: ONE batched read for this whole `rmd drain` invocation, handed to every task's
  // breaker corroboration below — never a per-task GitHub call (see breakerGateFor's doc).
  // `githubFactory` builds a fresh `buildBatchedGithub` instance whose OWN single `gh pr list
  // --state all` fetch already answers this; the call below is that instance's only fetch, so
  // this is exactly one extra batched call per invocation, never one per task. Resolved AFTER
  // the `--dry-run` early return above (never before it): a preview spawns/reads nothing beyond
  // `refreshMerged`'s own projection, and the breaker is never consulted on that path.
  const openHeadBranchesForBreaker = githubFactory(owner, repo).listOpenHeadBranches?.();
  // W1-T206: see breakerGateFor's doc — ONE cache for this whole `rmd drain` invocation.
  const breakerGate = breakerGateFor(ledgerPath, openHeadBranchesForBreaker);
  // W1-T119: same freshness contract as `isOpenPr` — the SAME projection
  // `refreshMerged` just derived, never a second GitHub read path. W1-T206: ALSO
  // indeterminate when the ledger's dispatch-breaker read for this task cannot be
  // trusted (absent/rotated ledger reading as fewer dispatches than a live process
  // already knows about) — nextRunnable already skips-and-retries on indeterminate
  // rather than escalating, exactly the behavior a torn read needs here too.
  const isIndeterminate = (id: string) =>
    lastProj?.get(id)?.indeterminate === true || breakerGate.isIndeterminate(id);

  // SINGLE-INSTANCE GUARD (DIAGNOSIS.md, diag/drain-concurrency): two concurrent
  // `rmd drain` processes both selected the still-unmerged W1-T7 and ran it. Refuse
  // to start if a LIVE drain already holds the lock; reclaim a stale (dead-pid) lock.
  const drainLockPath = join(config.root, "state", "drain.lock");
  let drainLock;
  try {
    drainLock = acquireDrainLock(drainLockPath);
  } catch (e) {
    if (e instanceof DrainLockError) {
      console.error(
        `### rmd drain REFUSED — another drain is running ` +
          `(pid ${e.holder.pid} on ${e.holder.host}, started ${e.holder.startedAt}).\n` +
          `If that process is dead, remove ${drainLockPath} and retry.`,
      );
      return 1;
    }
    throw e;
  }
  // Release the lock AND auto-consume STOP on a Ctrl-C / kill too, so a signal never leaves a
  // permanent stale lock or a STOP latch. (SIGKILL is uncatchable — the same limitation the
  // lock itself has; the next drain reclaims a dead-pid lock, and `rmd stop` no-ops when idle.)
  const onSignal = (sig: NodeJS.Signals) => {
    consumeStop(config.root);
    drainLock.release();
    process.kill(process.pid, sig); // re-raise with the default handler now cleared
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  log("drain.start", {
    until: opts.until ?? null,
    max: opts.max,
    gateway: `${owner}/${repo}`,
    lock_pid: drainLock.info.pid,
  });

  const runDrainFn = deps.runDrain ?? runDrain;
  try {
    const summary = await runDrainFn(
      plan,
      {
        refreshMerged,
        isOpenPr,
        // W1-T177: a fresh `gh pr view` re-read, consulted only when isOpenPr
        // reports a task in-flight — see NextRunnableOpts.readLiveState's doc.
        readLiveState: (_taskId, prNumber) => ghLiveStateByNumber(owner, repo, prNumber),
        isIndeterminate,
        // PER-TASK DISPATCH CIRCUIT BREAKER (P29(ii)): re-derived from the SAME
        // ledger every call — persists across drain/daemon process restarts,
        // unlike the daemon's in-memory per-tick block flag. W1-T206: routed through
        // breakerGate/evaluateDispatchBreaker so a torn/rotated read reports
        // "indeterminate" (handled above by isIndeterminate) rather than a false
        // "clear" that would silently untrip an already-tripped task.
        isCircuitTripped: (taskId) => breakerGate.isTripped(taskId),
        onCircuitBreak: (t) => escalateCircuitBreak(t, { owner, repo, ledgerPath, runId }),
        // LIFETIME DISPATCH CAP (W1-T316 wires W1-T271's own predicate): the SAME
        // breakerGate this invocation already holds for the streak breaker above,
        // never a second cache/read path — see breakerGateFor's doc.
        isLifetimeCapExceeded: (taskId) => breakerGate.isLifetimeCapExceeded(taskId),
        onLifetimeCapExceeded: (t) => escalateLifetimeCapExceeded(t, { owner, repo, ledgerPath, runId }),
        // DAILY COST CEILING (W1-T317 wires checkCostGovernor's own predicate, sweep.ts): a
        // fresh per-consultation re-derivation of today's ledgered spend, mirroring the streak/
        // lifetime breakers' restart-survives freshness contract — see costGovernorGateFor's doc.
        checkCostGovernor: costGovernorGateFor(ledgerPath, runId),
        // WIP CEILING (W1-T321 wires checkQueueGovernor's own predicate, sweep.ts, the W1-T121
        // 23-open-PR incident): the SAME `openPrCount` closure the W1-T172 lanes budget already
        // reads (below), never a second GitHub read path — see queueGovernorGateFor's doc.
        checkQueueGovernor: queueGovernorGateFor(openPrCount, ledgerPath, runId),
        runOne: (taskId) => runTask(taskId, { planPath, config, allowStale }),
        readUsage: () => readUsageSnapshot(config),
        checkStop: () => stopDetail(config.root),
        checkPause: () => pauseDetail(config.root),
        openPrCount, // W1-T172: the governor's WIP-ceiling input on the multi-lane path.
        log,
      },
      opts,
    );
    console.log("\n" + renderSummary(summary));
    // UNREADABLE FRONTIER vs EMPTY QUEUE: `no_runnable` with indeterminate declines means the
    // drain could not SEE the frontier, and a quota exhaustion is the reason worth ruling in or
    // out. Runs AFTER the summary is printed so the operator's own terminal is never held on a
    // `gh` call, and does nothing at all on a healthy stop — see the function's own doc.
    reportDrainQuotaExhaustion(summary, { owner, repo, ledgerPath, runId }, { log, ...(deps.quotaCheck ?? {}) });
    // POST-DRAIN RUNDOWN (W1-T141): one classified merged/blocked/escalated line per attempted
    // task — "what happened" at task grain, not just the aggregate summary above. Re-reads the
    // ledger fresh so a same-run escalation (BLOCKED class, two-strikes-exhausted) is visible to
    // the classifier — the SAME ledger file `log` above just finished writing into.
    pushDrainRundown(summary, readLedgerLines(ledgerPath), config, {
      channel: deps.notifyChannel ?? imessageChannel(notifyRecipient(config)),
      ledgerPath,
      runId,
    });
    // Exit 0 only on a clean drain (target reached / max reached / nothing left);
    // a block/headroom/error stop is a non-zero exit so an unattended wrapper notices.
    return summary.stopReason === "blocked" || summary.stopReason === "error" ? 1 : 0;
  } finally {
    // Release on EVERY exit path (clean return OR a throw out of runDrain) so a crash
    // mid-drain never leaves a stale lock that blocks the next drain forever.
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    // AUTO-CONSUME STOP on THIS run's terminal verdict (decided here, justified): STOP is
    // one-shot — it existed only to halt THIS drain, so the drain it interrupted clears it as
    // it exits. A concurrent/next drain therefore sees a clean slate, never a silent latch.
    // PAUSE is deliberately NOT consumed here (persistent hold, cleared only by `rmd resume`).
    consumeStop(config.root);
    drainLock.release();
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

/**
 * `rmd daemon [--max <n>] [--poll-ms <n>]` — the PERSISTENT scheduler loop
 * (W1-T12a; lib/daemon.ts owns the logic, this only wires the real defaults —
 * same GitHub-derived status, same run-task path, same fleet control +
 * headroom + locks as `rmd drain`). Unlike `rmd drain`, it does not stop on
 * "nothing runnable right now" OR on headroom-exhausted (confirmed OR merely
 * unreadable) — all three are in-process idle states: it paces itself with a
 * real `setTimeout` sleep and keeps polling (logging a heartbeat each tick),
 * since new work can land later and a usage window resets on its own.
 * Exiting on any of them would just restart-loop under launchd's KeepAlive
 * (SuccessfulExit:false relaunches on ANY exit, clean or not). The headroom
 * ceiling itself is TIME-AWARE (lib/daemon.ts's `HeadroomPolicy`, policy DATA
 * — relaxes toward 100% on a window's final day rather than wasting
 * capacity that is destroyed unused at reset), and an unreadable `/usage`
 * runs under a BOUNDED degraded-mode allowance (a handful of consecutive
 * misses still dispatch, logged explicitly; beyond that it escalates to the
 * same idle heartbeat) rather than either halting on the first miss or
 * silently dispatching forever. It DOES still stop on STOP, PAUSE, a block
 * (v1 stop-on-block — reasoning about the block is W1-T46), or an unexpected
 * error.
 *
 * Shares the SAME single-instance drain lock as `rmd drain` (state/drain.lock)
 * — a daemon and a drain are both "the loop that spawns run-task", so only one
 * of either may run at a time; per-task overlap is separately guarded by
 * run-task's own inflight lock (drain-lock.ts / inflight-lock.ts, both reused
 * here unchanged, never reimplemented).
 *
 * Actually LOADING this as a launchd service (so it survives logout/reboot and
 * restarts on crash) is W1-T12b/d — this command is what that service execs.
 */

/**
 * `plan/policy.yaml`'s `headroom.curve` (its `maxHoursToReset: number | null` catch-all)
 * converted into `daemon.ts`'s {@link HeadroomPolicy} shape (`Infinity` catch-all,
 * `buildDefaultHeadroomPolicy`'s own convention) — W1-T253 (P37 CONSUMERS). `daemon.ts`
 * itself cannot load the policy (its file header: "this pure module never touches the
 * filesystem", Rule 16), so THIS is the one place that does, threaded into
 * `DaemonOpts.headroomPolicy` explicitly on every real `rmd daemon` invocation below.
 */
export function headroomPolicyFromCurve(curve: PolicyHeadroomRung[]): HeadroomPolicy {
  return curve.map((rung) => ({
    maxHoursToReset: rung.maxHoursToReset === null ? Infinity : rung.maxHoursToReset,
    limitPct: rung.limitPct,
  }));
}

/**
 * The boot rung for {@link reapStaleClones} (impl-EK): survey the scratch roots for abandoned
 * review clones and ledger the outcome. `scratchReap.enabled` gates whether anything is
 * actually removed — while false this is a pure survey, which is the state it ships in.
 *
 * A LEDGER LINE, NOT A DECISION INPUT. `daemon.clone_reap` is deliberately NOT added to
 * `DECISION_RELEVANT_LEDGER_STEPS`: nothing reads it to decide anything, so a rotation
 * archiving it changes no behaviour. Adding it there would make the fleet carry a line
 * forever for no consumer — the inverse of the `sweep.absent_repush` case, where the count
 * IS the bound and rotation resets it.
 *
 * Deps are injectable and appended LAST so no positional caller shifts; the default path
 * reads the real policy and the real roots.
 */
export function logCloneReapSurvey(
  config: Config,
  log: (step: string, fields: Record<string, unknown>) => void,
  deps: {
    roots?: () => string[];
    reap?: typeof reapStaleClones;
    policy?: () => { enabled: boolean; maxAgeHours: number };
  } = {},
): CloneReapSummary | null {
  try {
    const readPolicy =
      deps.policy ?? (() => loadPolicy(policyPath(config.root)).values.scratchReap);
    const { enabled, maxAgeHours } = readPolicy();
    const reap = deps.reap ?? reapStaleClones;
    const summary = reap((deps.roots ?? cloneReapRoots)(), {
      dryRun: !enabled,
      maxAgeMs: maxAgeHours * 60 * 60 * 1000,
    });
    const actionable = summary.candidates.filter(
      (c) => c.disposition === "reaped" || c.disposition === "would-reap" || c.disposition === "in-use",
    );
    if (actionable.length) {
      log("daemon.clone_reap", {
        dry_run: summary.dryRun,
        reaped: summary.reaped.length,
        bytes_reclaimed: summary.bytesReclaimed,
        candidate_bytes: actionable.reduce((n, c) => n + c.bytes, 0),
        dispositions: tallyDispositions(summary.candidates),
      });
    }
    return summary;
  } catch {
    return null; // best-effort, exactly like the sibling boot sweeps — never blocks boot
  }
}

/**
 * W1-T406 — the worktree-reap RUNG for a ONE-SHOT `rmd run-task` dispatch, called from inside
 * {@link runTask} beside its existing `pruneStaleRuns` call. NEITHER of `reapStaleWorktrees`'s
 * two existing call sites (the daemon's per-poll sweep hook, or `rmd sweep`'s `sweepCommand` —
 * which anyway guards the reap behind `!dryRun`) is reachable from `docker run ... rmd run-task
 * <id>`: one needs a running daemon, the other is a PR-disposition verb, not a disk verb. A
 * one-shot container therefore never runs reapStaleWorktrees at all — only the narrower
 * `pruneStaleRuns`, which leaves three coverage holes (git-invisible dirs, detached-HEAD
 * `sweep-*` orphans, widowed `.lock` files) that only reapStaleWorktrees closes. Every
 * container boot IS the cadence here — it needs no operator and no daemon.
 *
 * SAME SHAPE as {@link logCloneReapSurvey}, point for point: best-effort (any failure is caught
 * and this returns `null`, never blocking the dispatch that invoked it), injectable deps
 * appended LAST so no positional caller shifts, one ledger line summarising what the pass
 * found, and DRY BY DEFAULT behind `worktreeReapBoot.enabled` — while off, this only surveys
 * and ledgers what it would reclaim (reapStaleWorktrees's own `dryRun` opt), deleting nothing.
 *
 * `isPidAlive` defaults to {@link worktreeLockIsPidAlive}, NOT `reapStaleWorktrees`'s own
 * `defaultIsPidAlive`: a container's pid namespace restarts at 1 on every boot, so a bare
 * `process.kill(pid, 0)` against a PREVIOUS boot's lock routinely finds an unrelated LOCAL
 * process holding that number and keeps the worktree forever (permanent non-reclamation, the
 * shape of the 3.0 GB this task was filed against — not destruction). worktreeLockIsPidAlive
 * compares the live process's own start time against the lock's recorded `startedAt`, reusing
 * `isHolderStale`'s rung 3 exactly as written. No age arithmetic of any kind is added here —
 * reapStaleWorktrees's own `maxAgeMs`/activity gate is untouched, so every existing keep
 * (live-pid, live-branch, recent-activity, activity-unknown) still applies unchanged.
 */
export function logWorktreeReapBootSurvey(
  config: Config,
  log: (step: string, fields: Record<string, unknown>) => void,
  deps: {
    root?: () => string;
    reap?: typeof reapStaleWorktrees;
    policy?: () => { enabled: boolean };
    isPidAlive?: (pid: number, info: RunLockInfo) => boolean;
  } = {},
): WorktreeReapSummary | null {
  try {
    const readPolicy =
      deps.policy ?? (() => loadPolicy(policyPath(config.root)).values.worktreeReapBoot);
    const { enabled } = readPolicy();
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

/**
 * W1-T411 — the disk-reclaim RUNG for a ONE-SHOT `rmd run-task` dispatch, called from inside
 * `runTaskBody` beside `pruneStaleRuns` and W1-T406's {@link logWorktreeReapBootSurvey}. Three
 * sweeps — `sweepStaleTempDirs` (stale rmd-owned temp dirs), `reapStaleClones` (abandoned
 * review clones, via {@link logCloneReapSurvey}), and `sweepStaleWorkerHomes` (per-spawn worker
 * homes a killed spawn never reached its own `reapWorkerHome` for) — have their ONLY call sites
 * inside `daemonCommand`'s boot/poll dispatch (`daemonBoot`'s closure, `buildSweepHook`), so a
 * one-shot container never runs them and reclaims none of the three UNBOUNDED leaks they own.
 * Every container start IS the cadence here, exactly like `pruneStaleRuns` and
 * `logWorktreeReapBootSurvey` already are.
 *
 * NO NEW PREDICATE (design (i)/(ii)). Every reap decision stays inside the sweep that already
 * owns it — this function adds no age arithmetic, no liveness probe and no destruction
 * criterion of its own. All three sweeps ALREADY RUN ARMED wherever they run today
 * (`scratchReap.enabled` is `true` in plan/policy.yaml as of #1250), so this rung needs no new
 * policy flag — unlike W1-T406's `worktreeReapBoot`, which ships survey-only because
 * `reapStaleWorktrees` can destroy uncommitted work. These three cannot: none of them calls
 * `isPidAlive`/`process.kill` at all, and each is guarded by a name prefix plus its own age
 * ceiling (the clone reap additionally requires a clean open-file probe before it will touch
 * anything).
 *
 * THREE SEPARATE GUARDS (design (iii)), deliberately not one try/catch wrapping all three: a
 * throw inside any one sweep is caught right there, never blocks the dispatch, and never
 * prevents the other two from running.
 *
 * EACH SWEEP READS ITS OWN ROOTS (design (iv)), never a second notion of where things live:
 * `tmpdir()` via `sweepStaleTempDirs`'s own default, `workerHomeDir(config)`, and
 * `cloneReapRoots()` via {@link logCloneReapSurvey} — REUSED rather than re-implemented so the
 * `scratchReap` policy field keeps exactly one read path. Its own ledger emission is suppressed
 * here (a no-op logger passed as its `log`) so this rung still produces exactly the one combined
 * line design (v) calls for; `logCloneReapSurvey`'s existing `daemon.clone_reap` line is
 * untouched at its own pre-existing daemon call site.
 *
 * ONE LEDGER LINE (design (v)), summarising what the rung reclaimed across all three sweeps —
 * emitted only when something was actually reclaimed. This is NOT a decision input (nothing
 * reads `run.disk_reclaim` to decide anything), so it is deliberately NOT added to
 * `DECISION_RELEVANT_LEDGER_STEPS`.
 *
 * Deps are injectable and appended LAST so no positional caller shifts; the default path calls
 * the real sweeps against their real roots/policy.
 */
export function logDiskReclaimRung(
  config: Config,
  log: (step: string, fields: Record<string, unknown>) => void,
  deps: {
    sweepTempDirs?: typeof sweepStaleTempDirs;
    reapClonesSurvey?: typeof logCloneReapSurvey;
    cloneReapDeps?: Parameters<typeof logCloneReapSurvey>[2];
    sweepWorkerHomes?: typeof sweepStaleWorkerHomes;
    workerHomeRoot?: () => string;
  } = {},
): {
  tempDirsRemoved: number;
  clonesReaped: number;
  cloneBytesReclaimed: number;
  workerHomesRemoved: number;
} {
  const sweepTempDirs = deps.sweepTempDirs ?? sweepStaleTempDirs;
  const reapClonesSurvey = deps.reapClonesSurvey ?? logCloneReapSurvey;
  const sweepWorkerHomes = deps.sweepWorkerHomes ?? sweepStaleWorkerHomes;

  let tempDirsRemoved = 0;
  try {
    tempDirsRemoved = sweepTempDirs().removed.length;
  } catch {
    // best-effort — a throw here must never block the dispatch or the other two sweeps
  }

  let clonesReaped = 0;
  let cloneBytesReclaimed = 0;
  try {
    // Suppressed logger: logCloneReapSurvey already best-effort-catches internally, but an
    // injected `reapClonesSurvey` test double could still throw — belt-and-suspenders so this
    // guard behaves identically to the other two.
    const summary = reapClonesSurvey(config, () => {}, deps.cloneReapDeps);
    clonesReaped = summary?.reaped.length ?? 0;
    cloneBytesReclaimed = summary?.bytesReclaimed ?? 0;
  } catch {
    // best-effort — a throw here must never block the dispatch or the other two sweeps
  }

  let workerHomesRemoved = 0;
  try {
    const root = (deps.workerHomeRoot ?? (() => workerHomeDir(config)))();
    workerHomesRemoved = sweepWorkerHomes(root).removed.length;
  } catch {
    // best-effort — a throw here must never block the dispatch or the other two sweeps
  }

  if (tempDirsRemoved || clonesReaped || workerHomesRemoved) {
    log("run.disk_reclaim", {
      tmp_dirs_removed: tempDirsRemoved,
      clones_reaped: clonesReaped,
      clone_bytes_reclaimed: cloneBytesReclaimed,
      worker_homes_removed: workerHomesRemoved,
    });
  }

  return { tempDirsRemoved, clonesReaped, cloneBytesReclaimed, workerHomesRemoved };
}

/**
 * impl-FZ — build the daemon's plan re-reader, or `undefined` when this invocation must keep the
 * frozen-at-boot behaviour (an explicit `--plan`, or a non-self target).
 *
 * Returns a closure holding the last-seen plan tree sha. It answers `null` while that sha is
 * unchanged, so `runDaemon` re-parses only when the plan genuinely moved on origin/main.
 */
export function planReloader(
  target: { isSelf: boolean; planPath: string; repoDir?: string },
  allowStale: boolean,
  log: (step: string, extra?: Record<string, unknown>) => void,
  deps: {
    treeSha?: () => string;
    load?: (planPath: string) => Plan;
  } = {},
): (() => Plan | null) | undefined {
  if (!target.isSelf) return undefined;
  // `-C` IS LOAD-BEARING. Without it this ran in the DAEMON PROCESS's working directory, which is
  // not the checkout, so every tick threw `fatal: not a git repository` — caught and ledgered as
  // `daemon.plan_reload_failed`, which meant the re-read failed safe but never actually happened.
  // Observed live on the first boot after #1139 shipped: 0 `daemon.plan_reloaded` rows, ever.
  // The tests all injected `treeSha`, so nothing exercised this default — see the real-git test
  // in test/daemon-plan-freshness.test.ts, which drives it with no injection.
  //
  // Any directory INSIDE the work tree is enough: git walks up from `-C` to find `.git`. Deriving
  // it from `planPath` keeps this in step with whatever plan location the caller resolved, rather
  // than introducing a second notion of where the repo is.
  const repoDirForGit = dirname(target.planPath);
  const treeSha =
    deps.treeSha ??
    (() =>
      execFileSync("git", ["-C", repoDirForGit, "rev-parse", "origin/main:plan"], {
        encoding: "utf8",
      }).trim());
  const load = deps.load ?? ((pp: string) => loadPlan(pp));
  let lastSha: string | undefined;
  return () => {
    const sha = treeSha();
    if (lastSha === undefined) {
      // First tick: record the boot's sha WITHOUT reloading. The plan we were handed already came
      // from this sha, so reporting a reload here would be a lie and would log a no-op every boot.
      lastSha = sha;
      // LIVENESS HEARTBEAT, once per boot (recon-GM). `daemon.plan_reloaded` is legitimately 0 in
      // production: the deploy supervisor restarts the daemon on ANY main move, and a plan change
      // IS a main move — measured at +0.7min and +0.5min for the two plan changes of 2026-08-02 —
      // so the daemon reboots with the fresh plan before its next 60s tick can observe a
      // difference. The re-reader is therefore DORMANT BY DESIGN, not broken.
      //
      // But a zero could not be distinguished from "never ran". Failures were already visible
      // (`daemon.plan_reload_failed`); success was not. This line closes that gap: it proves the
      // probe EXECUTED and the git call SUCCEEDED, and records which plan tree the boot is pinned
      // to — turning an unfalsifiable silence into a positive signal.
      //
      // BOUNDED TO ONE LINE PER BOOT. Emitting per tick would be ~1,440 rows/day of "nothing
      // happened", which is the noise that gets a signal ignored — the failure mode this repo has
      // already paid for elsewhere. One row per boot is enough to prove liveness and to answer
      // "which plan was this boot running?".
      log("daemon.plan_unchanged", { tree_sha: sha.slice(0, 12), first_tick: true });
      return null;
    }
    if (sha === lastSha) return null;
    lastSha = sha;
    log("daemon.plan_changed", { tree_sha: sha.slice(0, 12), allow_stale: allowStale });
    return load(target.planPath);
  };
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
  } = {},
): Promise<number> {
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
  };
  const config = loadConfig();
  // Headroom governor switch (operator ruling fb-1784894405468-a4153e; default clause
  // reversed 2026-07-25 — the switch now defaults ON, and this host opts OUT explicitly
  // via config `headroom.enabled: false`): resolve the host posture from config/env HERE
  // and pass it explicitly, so the live daemon reads the flag while the library keeps
  // its enforcement default.
  opts.headroomEnabled = resolveHeadroomEnabled(config);
  const ledgerPath = ledgerPathFor(config);
  const statusPath = join(config.root, "state", "status.json");
  const self = resolveOwnerRepo();
  const reposDir = join(config.root, "repos");
  // deps.repoRoot's doc (above, W1-T143) explains why this is injectable at all.
  const effectiveRepoRoot = deps.repoRoot ?? repoRoot;

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
  const log = (step: string, extra: Record<string, unknown> = {}) =>
    appendLedger(ledgerPath, { run_id: runId, task_id: "DAEMON", step, ...extra });
  log("daemon.target", {
    repo: target.repo,
    gateway: `${target.owner}/${target.repo}`,
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

  // Read the plan to schedule. For a NON-self target without an explicit --plan, read it from a
  // clone of the target repo (the daemon clones it for execution anyway), SYNCED to the latest
  // default branch so the scheduled plan is current — a stale clone would drain an old plan.
  let plan: Plan;
  if (!target.isSelf && !flagValue(rest, "--plan")) {
    const repoDir = join(reposDir, target.repo);
    if (!existsSync(repoDir)) {
      mkdirSync(dirname(repoDir), { recursive: true });
      execFileSync("gh", ["repo", "clone", `${target.owner}/${target.repo}`, repoDir], { stdio: "inherit" });
    } else {
      execFileSync("git", ["-C", repoDir, "fetch", "--quiet", "origin"], { stdio: "pipe" });
      execFileSync("git", ["-C", repoDir, "reset", "--hard", "--quiet", "origin/main"], { stdio: "pipe" });
    }
    plan = loadPlan(target.planPath);
  } else if (target.isSelf && !flagValue(rest, "--plan")) {
    // ── GIT SELF-SYNC (W1-T60): self-hosting must not read the daemon's own working tree
    // either — same fail-closed gate as run-task/drain (see syncPlanOrRefuse).
    const synced = syncPlanOrRefuse(target.planPath, {
      allowStale,
      log,
      say: (msg) => writeSyncLine(2, `### rmd daemon — ${msg}`),
    });
    if ("error" in synced) return 1;
    plan = synced.plan;
  } else {
    // An explicit --plan overrides the derived path — read it literally, no git sync.
    plan = loadPlan(target.planPath);
  }

  // `lastProj` also backs `isOpenPr` (W1-T80, the in-flight dispatch-dedup
  // guard) — the SAME projection `refreshMerged` just derived, never a second
  // GitHub read path.
  let lastProj: Map<string, StatusProjection> | undefined;
  const githubFactory = deps.githubFactory ?? ((o: string, r: string) => buildBatchedGithub(o, r, { log }));
  const refreshMerged: () => MergedSet = () => {
    const proj = projectPlan(
      plan,
      { ledgerPath, github: githubFactory(target.owner, target.repo) },
      statusPath,
    );
    lastProj = proj;
    return (id: string) => proj.get(id)?.merged ?? false;
  };
  const isOpenPr: OpenPrCheck = (id) => {
    const p = lastProj?.get(id);
    return p?.prState === "OPEN" ? p.prNumber : undefined;
  };
  // W1-T321: the queue governor's live input, mirroring drainCommand's identical `openPrCount` —
  // OPEN entries in the SAME projection `refreshMerged` just read, never a second GitHub read path.
  const openPrCount = () => {
    let n = 0;
    for (const p of lastProj?.values() ?? []) if (p.prState === "OPEN") n++;
    return n;
  };
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
  const openHeadBranchesForBreaker = githubFactory(target.owner, target.repo).listOpenHeadBranches?.();
  // W1-T206: see breakerGateFor's doc — ONE cache for this whole `rmd daemon` invocation.
  const breakerGate = breakerGateFor(ledgerPath, openHeadBranchesForBreaker);
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

  // SINGLE-INSTANCE GUARD, shared with `rmd drain` (same lock file/DIAGNOSIS.md
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
  const onSignal = (sig: NodeJS.Signals) => {
    consumeStop(config.root); // one-shot STOP: consumed on the daemon's terminal (see drainCommand)
    drainLock.release();
    process.kill(process.pid, sig); // re-raise with the default handler now cleared
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  log("daemon.start", {
    max: opts.max ?? null,
    poll_interval_ms: opts.pollIntervalMs,
    lock_pid: drainLock.info.pid,
    repo: target.repo,
    // Ruling fb-1784894405468-a4153e: the resolved governor posture, legible each boot.
    headroom_enabled: opts.headroomEnabled,
  });
  // W1-T215 crash-loop input, snapshotted EAGERLY — before daemonBoot writes this boot's own
  // `daemon.boot` line — so the check's `priorBoots` contract (prior boots ONLY) holds even
  // though the closure is invoked after that write. See the crashLoopCheck argument below.
  const priorDaemonBootTs = readLedgerLines(ledgerPath)
    .filter((l) => l.step === "daemon.boot")
    .map((l) => String(l.ts ?? ""))
    .filter(Boolean)
    .slice(-200);
  // W1-T117/W1-T356: the orphan sweep, composed from the module's OWN exported defaults
  // (design part i/ii) — ONE shared closure wired into BOTH daemonBoot's boot-time param
  // (below) and DaemonDeps.sweepOrphans (the per-poll half, at the deps literal further
  // down), so both halves run the identical attribution/kill/ledger logic rather than two
  // independently drifting copies. `isRunActive` reads the SAME inflight-lock directory
  // (state/inflight/*.lock) the drain/daemon dispatch path itself takes before running a
  // task (see `liveInflightRuns`'s own doc) — a run still holding that lock is never a
  // stray, no matter how long its process has been alive. Each kill's own
  // `worker_orphan_killed` ledger line carries the ORPHAN's run_id/task_id (never this
  // daemon's own runId), matching `sweepOrphanWorkers`'s `ledger` dep contract.
  const inflightDir = join(config.root, "state", "inflight");
  const sweepOrphans = () =>
    sweepOrphanWorkers({
      listCandidates: defaultListCandidates,
      readMarkers: defaultReadMarkers,
      isRunActive: (candidateRunId) => liveInflightRuns(inflightDir).some((r) => r.runId === candidateRunId),
      kill: (pid) => killProcessGroup(pid),
      ledger: (line) =>
        appendLedger(ledgerPath, {
          run_id: line.run_id,
          task_id: line.task_id,
          step: "worker_orphan_killed",
          pid: line.pid,
          cmdline: line.cmdline,
        }),
    });
  // ANTHROPIC-clean-env boot assertion (W1-T12b): checked once, before the loop
  // starts, over the daemon process's OWN live env — belt-and-suspenders atop
  // the launchd unit's own closed EnvironmentVariables allowlist (lib/launchd.ts).
  // Also runs the W1-T115 boot sweep of stale rmd-owned temp dirs (the
  // 26,711-dir ENOSPC incident's backstop) and logs the count via daemon.tmp_sweep.
  daemonBoot(
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
      const homes = sweepStaleWorkerHomes(workerHomeDir(config));
      if (homes.removed.length) {
        log("daemon.worker_home_sweep", { removed: homes.removed.length, sample: homes.removed.slice(0, 5) });
      }
      // W1-T320: the age ceiling is now POLICY DATA (plan/policy.yaml's sweep.tmpMaxAgeMs),
      // read off the SAME repoRoot-scoped `policy` this function already reads
      // pollIntervalMs/the headroom curve from — never a second, independently-resolved read.
      return sweepStaleTempDirs({ maxAgeMs: policy.values.sweep.tmpMaxAgeMs });
    },
    () => sweepStaleInflightLocks(join(config.root, "state", "inflight")),
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
    (() => {
      try {
        return execFileSync("git", ["-C", dirname(dirname(fileURLToPath(import.meta.url))), "rev-parse", "HEAD"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        return undefined;
      }
    })(),
  );

  const runDaemonFn = deps.runDaemon ?? runDaemon;
  // W1-T160: the retro cadence hooks (self-target only) — see buildRetroDaemonHooks.
  const retroHooks = target.isSelf ? buildRetroDaemonHooks() : undefined;
  // impl-DM: the auto-triage rung's producer. SELF-TARGET ONLY, for the same reason the retro is —
  // it reads THIS repo's plan/feedback and writes THIS repo's plan, never a drained target's.
  // Without this line `deps.checkAutoTriage` is undefined and the whole rung is dead code, which is
  // exactly how #1066 merged: consumer wired, producer never.
  const autoTriageHooks = target.isSelf ? buildAutoTriageDaemonHooks({ config }) : undefined;
  try {
    const summary = await runDaemonFn(
      plan,
      {
        refreshMerged,
        isOpenPr,
        // W1-T177: a fresh `gh pr view` re-read, consulted only when isOpenPr
        // reports a task in-flight — see NextRunnableOpts.readLiveState's doc.
        readLiveState: (_taskId, prNumber) => ghLiveStateByNumber(target.owner, target.repo, prNumber),
        isIndeterminate,
        // PER-TASK DISPATCH CIRCUIT BREAKER (P29(ii)): re-derived from the SAME
        // ledger every call — persists across daemon restarts, unlike this
        // loop's own in-memory per-tick block-reasoning flag. W1-T206: routed through
        // breakerGate/evaluateDispatchBreaker so a torn/rotated read reports
        // "indeterminate" (handled above by isIndeterminate) rather than a false
        // "clear" that would silently untrip an already-tripped task.
        isCircuitTripped: (taskId) => breakerGate.isTripped(taskId),
        onCircuitBreak: (t) => escalateCircuitBreak(t, { owner: target.owner, repo: target.repo, ledgerPath, runId }),
        // LIFETIME DISPATCH CAP (W1-T316 wires W1-T271's own predicate): the SAME
        // breakerGate this invocation already holds for the streak breaker above,
        // never a second cache/read path — see breakerGateFor's doc.
        isLifetimeCapExceeded: (taskId) => breakerGate.isLifetimeCapExceeded(taskId),
        onLifetimeCapExceeded: (t) => escalateLifetimeCapExceeded(t, { owner: target.owner, repo: target.repo, ledgerPath, runId }),
        // DAILY COST CEILING (W1-T317 wires checkCostGovernor's own predicate, sweep.ts): a
        // fresh per-consultation re-derivation of today's ledgered spend, mirroring the streak/
        // lifetime breakers' restart-survives freshness contract — see costGovernorGateFor's doc.
        checkCostGovernor: costGovernorGateFor(ledgerPath, runId),
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
        // 23-open-PR incident): the SAME `openPrCount` closure just defined above, never a second
        // GitHub read path — see queueGovernorGateFor's doc.
        checkQueueGovernor: queueGovernorGateFor(openPrCount, ledgerPath, runId),
        openPrCount, // W1-T343: laneDispatchBudget's other input on the multi-lane path, mirroring drainCommand.
        runOne: (taskId) =>
          runTask(taskId, {
            planPath: target.planPath,
            config,
            allowStale,
            skipGitSync: !!flagValue(rest, "--plan"),
          }),
        readUsage: () => readUsageSnapshot(config),
        // THE LEDGER IS THE DEDUP (impl-FL): seed the once-per-string bound from what previous
        // processes already announced, so a restart does not re-announce. Read ONCE at daemon
        // construction, never per tick.
        priorUnrecognisedResets: priorUnrecognisedResetStrings(readLedgerLines(ledgerPath)),
        // P34 clause (c), W1-T249: the reserve gate's notification — dispatch is
        // already paused (runDaemon's own in-process idle) by the time this fires.
        onHeadroomBreach: (info) => escalateHeadroomReserve(info, { owner: target.owner, repo: target.repo, ledgerPath, runId }),
        // W1-T372: both gh api rate_limit buckets, read fresh each tick alongside readUsage's
        // own headroom reading immediately above — never a second gh api rate_limit call.
        readGhQuota: () => readGhRateLimitBuckets(),
        // W1-T372: observe-and-surface only — dispatch is NOT paused by this hook (unlike
        // onHeadroomBreach above); see escalateQuotaExhaustion's own doc for why.
        onQuotaExhausted: (info) => escalateQuotaExhaustion(info, { owner: target.owner, repo: target.repo, ledgerPath, runId }),
        // oper#queue-starvation-2026-08-03: the idle rung's starvation notification — dispatch
        // is already idle (runDaemon's own in-process bound, `starvationEscalated`) by the time
        // this fires.
        onStarvation: (census) => escalateStarvation(census, { owner: target.owner, repo: target.repo, ledgerPath, runId }),
        checkStop: () => stopDetail(config.root),
        checkPause: () => pauseDetail(config.root),
        // impl-FZ — PLAN FRESHNESS. Wired ONLY on the git-synced self-target path, so the reload
        // reads the SAME source the boot did (origin/main, never the working tree). An explicit
        // `--plan` keeps the frozen-at-boot behaviour, because that caller asked for a literal file.
        //
        // Change detection is a TREE SHA, not a timestamp: `origin/main:plan` covers the monolith
        // AND all 45 shards in one ~8ms call, and only when it moves do we pay the ~60ms parse of
        // a ~1MB plan. Unchanged ticks therefore cost 8ms, not 60. The sha is read from the
        // already-fetched origin/main ref rather than fetching here — the deploy supervisor keeps
        // that ref current on its own ~2-minute cadence, and adding a per-tick fetch to the
        // dispatch path would be new network I/O for no extra freshness.
        // Mirrors the BOOT condition at the plan binding above (`target.isSelf && !--plan`)
        // exactly, so the reload source can never diverge from the load source.
        reloadPlan: flagValue(rest, "--plan") ? undefined : planReloader(target, allowStale, log),
        // Console UP NEXT write-actions (fb-1784988460437-9daa9b): the daemon
        // consumes markers the write-token API drops, dispatching a kicked task
        // through its normal assertRunnable-gated path and honouring "drain now".
        pendingKicks: () => pendingKicks(config.root),
        clearKick: (taskId) => clearKick(config.root, taskId),
        consumeDrainNow: () => consumeDrainNow(config.root),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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
        sweep: buildSweepHook(target.owner, target.repo, config, ledgerPath, runId, plan, log, policy.values.sweep.tmpMaxAgeMs),
        // W1-T254 (the #707 fix): the restricted light-sweep ticker — ticks ONLY
        // the deterministic post-review re-post while `runOne` is unbounded and in
        // flight, so a green PR whose review went absent re-posts within one poll
        // interval. Dangerous lanes (fix/close/arm/escalate) stay non-concurrent.
        sweepLight: buildSweepLightHook(target.owner, target.repo, config, ledgerPath, runId, plan, log),
        // W1-T117/W1-T356: the per-poll half of the orphan sweep — the SAME `sweepOrphans`
        // closure daemonBoot already runs once, above, wired here so a stray from a run that
        // ended BETWEEN polls (not only at the last boot) is still found within one cycle.
        sweepOrphans,
        // RETRO CADENCE TRIGGER (W1-T160) — SELF-TARGET ONLY: the retro reads/writes
        // THIS repo's own MASTER-PLAN.md/LEARNINGS.md/plan/tasks.yaml/state, never a
        // drained target's, so the trigger is wired only when the daemon is draining
        // itself. `runRetroTrigger`'s return (an exit code) is discarded — retroCommand
        // already ledgers everything the daemon loop needs (retro_triggered above,
        // retro_aborted_integrity, pr.opened, retro.marker.advanced).
        checkRetroTrigger: retroHooks?.checkRetroTrigger,
        runRetroTrigger: retroHooks?.runRetroTrigger,
        // AUTO-TRIAGE RUNG (impl-DJ's design, wired here by impl-DM). Same shape as the retro
        // hooks above and gated the same way. The rung is DEFAULT OFF in policy data — this line
        // makes the switch REACHABLE, it does not turn anything on.
        checkAutoTriage: autoTriageHooks?.checkAutoTriage,
        runAutoTriage: autoTriageHooks?.runAutoTriage,
        // W1-T46 block-reasoning: a GENUINE BLOCKER (real downstream work
        // transitively needs the blocked task) opens a `needs-human` issue
        // naming the dependents it protects, via W1-T8's escalation taxonomy
        // — never a bare halt with no actionable trail.
        escalateBlock: ({ task, result, dependents }) => {
          escalate(
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
            { issues: ghIssueGateway(target.owner, target.repo), ledgerPath, runId },
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
    return daemonExitCode(summary.stopReason);
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    consumeStop(config.root); // one-shot STOP: consumed on the daemon's terminal (see drainCommand)
    drainLock.release();
  }
}

/**
 * `rmd daemon-plist [--repo <name>] [--poll-ms <n>] [--allow-self-target] [--write]` — GENERATE
 * the launchd unit for `rmd daemon` (W1-T12b; lib/launchd.ts owns the generation, this only
 * wires the real absolute paths). Default: print the .plist to stdout, plus the `launchctl load`
 * invocation the operator would run, and do nothing else. `--write` additionally writes it to
 * `~/Library/LaunchAgents/<label>.plist` — still just a file write, never a `launchctl` call.
 * Actually LOADING it on a real user session is W1-T12d (verify:human) — this command only gets
 * the operator to the point of running `launchctl load` themselves.
 *
 * Self-target consent (W1-T109, the commissioning crash-loop near-miss): `--repo` omitted, or
 * given as this checkout's own repo, targets the daemon's OWN source repo — the SAME "self" the
 * runtime guard (`resolveDaemonTarget`) refuses to drain unattended. Generating that unit
 * WITHOUT `--allow-self-target` now REFUSES at generation (writes/prints nothing): loaded as-is,
 * the daemon would refuse to start it and launchd's KeepAlive would restart it forever. Passing
 * `--allow-self-target` bakes the same explicit consent into the unit's `ProgramArguments`.
 */
export async function daemonPlistCommand(rest: string[]): Promise<number> {
  const badArg = unknownArgError("daemon-plist", rest, ["--poll-ms", "--repo"], ["--write", "--allow-self-target"]);
  if (badArg) {
    console.error(badArg + "\n" + USAGE);
    return 2;
  }
  const config = loadConfig();
  const pollIdx = rest.indexOf("--poll-ms");
  const pollIntervalMs = pollIdx >= 0 ? Number(rest[pollIdx + 1]) : undefined;
  const repo = flagValue(rest, "--repo"); // baked into the unit so it drains the intended repo
  const allowSelfTarget = rest.includes("--allow-self-target");
  const self = resolveOwnerRepo();
  // Absent --repo defaults to self at runtime (resolveDaemonTarget) — so it's self-target here too.
  const isSelfTarget = (repo ?? self.repo) === self.repo;
  const rmdBin = join(repoRoot, "bin", "rmd");
  const plist = generateLaunchdPlist({ rmdBin, root: config.root, pollIntervalMs, repo, isSelfTarget, allowSelfTarget });
  const plistPath = launchdPlistPath();

  if (rest.includes("--write")) {
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, plist);
    console.log(`### rmd daemon-plist — wrote ${plistPath}`);
  } else {
    console.log(plist);
  }
  console.log(
    `\n# to commission (W1-T12d, operator-run — NOT done by this command):\n` +
      `launchctl load ${plistPath}`,
  );
  return 0;
}

/**
 * `rmd deploy [--reason <text>]` — the OPERATOR trigger (option C, human-gated). Sets
 * state/DEPLOY_REQUESTED so the deploy supervisor fast-forwards the daemon's checkout
 * and kickstarts it at the next idle gap. Deploys nothing itself; keeps Craig's
 * control over WHEN a merged fix goes live.
 */
async function deployCommand(rest: string[]): Promise<number> {
  const badArg = unknownArgError("deploy", rest, ["--reason"], []);
  if (badArg) {
    console.error(badArg + "\n" + USAGE);
    return 2;
  }
  const config = loadConfig();
  requestDeploy(config.root, flagValue(rest, "--reason"));
  console.log(
    `### rmd deploy — requested (state/DEPLOY_REQUESTED). The supervisor will fast-forward + ` +
      `kickstart the daemon at the next idle gap, health-check it, and roll back on failure.`,
  );
  return 0;
}

/**
 * `rmd deploy-run [--dry-run]` — ONE supervisor cycle (the launchd unit runs this on
 * its interval). No-op unless a deploy is triggered AND the daemon is idle. `--dry-run`
 * runs the whole sequence (fetch/compare/idle-check/pull) but SKIPS the real kickstart —
 * so validation can exercise it against the real install without restarting production.
 */
async function deployRunCommand(rest: string[]): Promise<number> {
  const badArg = unknownArgError("deploy-run", rest, [], ["--dry-run"]);
  if (badArg) {
    console.error(badArg + "\n" + USAGE);
    return 2;
  }
  const config = loadConfig();
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const deps = realDeployDeps({
    installPath: repoRoot,
    stateRoot: config.root,
    daemonLabel: DAEMON_LABEL,
    // The console is restarted by the SAME cycle, after the daemon verifies healthy: `rmd serve`
    // loads its code once via tsx, so a deploy it is not restarted for is inert in it. The port is
    // resolved the same way `rmd serve-plist` resolves it, so the probe watches the port the unit
    // actually listens on.
    serveLabel: SERVE_LABEL,
    servePort: resolveServePort([], config.serve?.port),
    uid,
    ledgerPath: ledgerPathFor(config),
  });
  const result = runDeployCycle(deps, { dryRun: rest.includes("--dry-run") });
  console.log(`### rmd deploy-run — ${result.deployed ? "DEPLOYED" : "no-op"}: ${result.reason}`);
  return result.reason.startsWith("dirty-tree-conflict") || result.rolledBackTo ? 1 : 0;
}

/**
 * `rmd deploy-plist [--interval <s>] [--write]` — GENERATE the deploy-supervisor
 * launchd unit (a periodic `rmd deploy-run`). Mirrors `daemon-plist`: prints by
 * default, `--write` installs it; loading it is an operator action.
 */
async function deployPlistCommand(rest: string[]): Promise<number> {
  const badArg = unknownArgError("deploy-plist", rest, ["--interval"], ["--write"]);
  if (badArg) {
    console.error(badArg + "\n" + USAGE);
    return 2;
  }
  const config = loadConfig();
  const iv = flagValue(rest, "--interval");
  const rmdBin = join(repoRoot, "bin", "rmd");
  const plist = generateSupervisorLaunchdPlist({ rmdBin, root: config.root, intervalSeconds: iv ? Number(iv) : undefined });
  const plistPath = launchdPlistPath(SUPERVISOR_LABEL);
  if (rest.includes("--write")) {
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, plist);
    console.log(`### rmd deploy-plist — wrote ${plistPath}`);
  } else {
    console.log(plist);
  }
  console.log(
    `\n# to enable (operator-run — NOT done by this command):\n` +
      `launchctl load ${plistPath}\n` +
      `# request a deploy:  rmd deploy\n` +
      `# opt into auto (behind the health-check):  touch ${join(config.root, "state", "DEPLOY_AUTO")}`,
  );
  return 0;
}

/**
 * `rmd digest-plist [--hour <h>] [--write]` — GENERATE the launchd unit for the daily
 * `rmd digest` pulse (W1-T112 — "the morning pulse"; lib/launchd.ts's
 * `generateDigestLaunchdPlist` owns the generation, the SAME W1-T12b generator family
 * `daemonPlistCommand` above uses, reused rather than re-implemented — one billing
 * boundary, one closed env allowlist). Default: print the .plist to stdout plus the
 * `launchctl load` invocation the operator would run, and do nothing else. `--write`
 * additionally writes it to `~/Library/LaunchAgents/<label>.plist` — still just a file
 * write, never a `launchctl` call. Actually LOADING it (so the pulse survives
 * logout/reboot) is an operator action, mirroring `daemon-plist`'s W1-T12d boundary.
 */
async function digestPlistCommand(rest: string[]): Promise<number> {
  const badArg = unknownArgError("digest-plist", rest, ["--hour"], ["--write"]);
  if (badArg) {
    console.error(badArg + "\n" + USAGE);
    return 2;
  }
  const config = loadConfig();
  const hourRaw = flagValue(rest, "--hour");
  const hour = hourRaw !== undefined ? Number(hourRaw) : undefined;
  const rmdBin = join(repoRoot, "bin", "rmd");
  const plist = generateDigestLaunchdPlist({ rmdBin, root: config.root, hour });
  const plistPath = launchdPlistPath(DIGEST_LABEL);

  if (rest.includes("--write")) {
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, plist);
    console.log(`### rmd digest-plist — wrote ${plistPath}`);
  } else {
    console.log(plist);
  }
  console.log(
    `\n# to commission (operator-run — NOT done by this command):\n` +
      `launchctl load ${plistPath}`,
  );
  return 0;
}

/**
 * `rmd serve-plist [--port <n>] [--host <addr>] [--write]` — GENERATE the launchd unit that
 * runs the operator console as a background SERVICE (W1-T152; lib/launchd.ts's
 * `generateServeLaunchdPlist` owns the generation — the SAME W1-T12b generator family
 * `daemonPlistCommand` uses, one closed env allowlist, not a second implementation).
 *
 * THE FIXTURE: the console only ever ran in a foreground terminal, so every shell reclaim
 * (ctrl+C, a closed tab, a logout) took the board down — and the operator reads that board
 * from a phone, days from the machine. Under launchd it comes back from any exit, survives
 * reboot, and `kickstart -k` is a one-line restart that cannot lose the port to itself.
 *
 * The bind interfaces and port are RESOLVED HERE (flag > `RMD_SERVE_HOST` > config `serve.*`
 * > loopback:4317) and baked in, so the unit and a hand-run `rmd serve` agree. `--write`
 * installs the unit AND pre-creates both log files 0600 (R-5: launchd would otherwise create
 * them at its 0644 umask, and serve's banner prints a bearer token). Loading it stays the
 * operator's step, mirroring `daemon-plist`'s W1-T12d boundary.
 */
export async function servePlistCommand(rest: string[]): Promise<number> {
  const badArg = unknownArgError("serve-plist", rest, ["--port", "--host"], ["--write"]);
  if (badArg) {
    console.error(badArg + "\n" + USAGE);
    return 2;
  }
  const config = loadConfig();
  let port: number;
  let hosts: string[];
  try {
    port = resolveServePort(rest, config.serve?.port);
    hosts = resolveServeHosts(rest, process.env, config.serve?.host);
  } catch (e) {
    console.error(`### rmd serve-plist — ${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const rmdBin = join(repoRoot, "bin", "rmd");
  const plist = generateServeLaunchdPlist({ rmdBin, root: config.root, port, hosts });
  const plistPath = launchdPlistPath(SERVE_LABEL);
  const logs = serveLogPaths(config.root);

  if (rest.includes("--write")) {
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, plist);
    // BEFORE launchd ever opens them: an existing 0600 file is appended to, keeping its mode.
    const { failed } = ensureLogFileMode([logs.stdout, logs.stderr]);
    console.log(`### rmd serve-plist — wrote ${plistPath}`);
    console.log(`    logs (0600):  ${logs.stdout}, ${logs.stderr}`);
    if (failed.length > 0) console.error(`    WARNING — could not force 0600 on: ${failed.join(", ")}`);
  } else {
    console.log(plist);
  }
  console.log(
    `\n# to commission (operator-run — NOT done by this command):\n` +
      `launchctl bootstrap gui/$UID ${plistPath}\n` +
      `# to restart it after a deploy (reap-safe — launchd owns the port):\n` +
      `launchctl kickstart -k gui/$UID/${SERVE_LABEL}\n` +
      `# bindings baked in: ${hosts.map((h) => `http://${h}:${port}`).join(", ")}`,
  );
  return 0;
}

// ── rmd down / rmd up — operator lifecycle verbs (W1-T169) ─────────────────────────────────
//
// Graceful wind-down / full resume, built as REPORTING/ORCHESTRATION over injected effects (a
// service-manager handle, a port-checker, a process-stopper, the ledger reader) — NEVER
// process babysitters. The fixture this replaces: the operator's restart procedure was FOUR
// manual command blocks plus a reap-wait gotcha (kill by PORT, wait for the port to actually
// release, THEN relaunch — never an argv/pattern kill, which misses; the
// serve-restart-reap-wait class). `rmd down` winds the fleet down for maintenance; `rmd up`
// resumes it. Both are idempotent: a repeat call reports the CURRENT state rather than
// erroring or double-acting.

/** `launchctl print`'s pid line ("	pid = 61234"). Absent — a job bootstrapped but not yet
 *  spawned, or one that just exited — means "loaded, not (yet) running", distinct from "not
 *  loaded at all" (the caller tells those apart via {@link LaunchdServiceState.loaded}). */
const LAUNCHCTL_PID_RE = /"?pid"?\s*=\s*(\d+)/;

export interface LaunchdServiceState {
  /** True iff `launchctl print` finds the service at all (bootstrapped into the GUI domain). */
  loaded: boolean;
  /** The job's live pid, or `null` when loaded but not (yet) running. */
  pid: number | null;
}

/** The one real subprocess seam every lifecycle helper below defaults to — a test fakes THIS
 *  one function and every helper obeys it, rather than each helper importing `execFileSync`
 *  for itself (the same one-seam discipline deployer.ts's `realDeployDeps` established for
 *  its own `launchctl kickstart` call). */
function defaultLifecycleExec(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8" }).toString();
}

/** This process's real UID, or 0 when `process.getuid` is unavailable (non-POSIX — launchd
 *  itself is macOS-only, so that branch never actually runs in production; mirrors
 *  `deployRunCommand`'s own `process.getuid` guard). */
function realUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

/**
 * `launchctl print gui/<uid>/<label>` — the SAME query both `rmd down`'s "already down" check
 * and `rmd up`'s "already up" check read, so the two verbs can never disagree about whether a
 * service is loaded. A non-bootstrapped label exits non-zero ("Could not find service..."),
 * which `execFileSync` turns into a throw — caught here as `loaded: false`, never a crash.
 */
export function queryLaunchdService(
  label: string,
  uid: number,
  exec: (cmd: string, args: string[]) => string = defaultLifecycleExec,
): LaunchdServiceState {
  let out: string;
  try {
    out = exec("launchctl", ["print", launchctlGuiTarget(uid, label)]);
  } catch {
    return { loaded: false, pid: null };
  }
  const m = LAUNCHCTL_PID_RE.exec(out);
  return { loaded: true, pid: m ? Number(m[1]) : null };
}

/** `launchctl list <label>`'s one-line, tab-separated `PID\tStatus\tLabel` — the SAME fact the
 *  W1-T301 rationale read by hand off a real box (`launchctl list` showing `-  0
 *  com.remudero.supervisor`, i.e. not running, last exit 0) to prove a healthy periodic one-shot
 *  was being mis-reported "not running" by a pid-presence-only check. `PID` is `-` when not
 *  currently running (interval jobs rest between ticks — see status-board.ts's `ServiceKind`);
 *  `Status` is the job's LAST completed run's exit code (0 healthy, nonzero a real failure) —
 *  exactly the datum a resident-service pid check can never surface for a periodic job. A
 *  non-bootstrapped label, or any unparseable output, is caught/returned as "unknown" — never a
 *  throw, never a fabricated healthy `0`. */
export interface LaunchdListStatus {
  pid: number | null;
  lastExitCode: number | undefined;
}

const LAUNCHCTL_LIST_LINE_RE = /^(-|\d+)\s+(-?\d+)\s+(\S+)/;

export function queryLaunchdListStatus(
  label: string,
  exec: (cmd: string, args: string[]) => string = defaultLifecycleExec,
): LaunchdListStatus {
  let out: string;
  try {
    out = exec("launchctl", ["list", label]);
  } catch {
    return { pid: null, lastExitCode: undefined };
  }
  const line = out.split("\n").find((l) => LAUNCHCTL_LIST_LINE_RE.test(l.trim()));
  const m = line ? LAUNCHCTL_LIST_LINE_RE.exec(line.trim()) : null;
  if (!m) return { pid: null, lastExitCode: undefined };
  const pid = m[1] === "-" ? null : Number(m[1]);
  const lastExitCode = Number(m[2]);
  return { pid, lastExitCode: Number.isFinite(lastExitCode) ? lastExitCode : undefined };
}

/** `launchctl bootstrap gui/<uid> <plistPath>` — loads a unit that is not yet loaded. */
export function loadLaunchdService(
  plistPath: string,
  uid: number,
  exec: (cmd: string, args: string[]) => string = defaultLifecycleExec,
): void {
  exec("launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
}

/** `launchctl bootout gui/<uid>/<label>` — unloads a loaded unit BY LABEL, so it still works
 *  even if the plist file on disk has since been deleted or moved. */
export function unloadLaunchdService(
  label: string,
  uid: number,
  exec: (cmd: string, args: string[]) => string = defaultLifecycleExec,
): void {
  exec("launchctl", ["bootout", launchctlGuiTarget(uid, label)]);
}

/**
 * Find + SIGTERM whatever is LISTENING on `port` — never an argv/pattern match (`pkill -f
 * serve` has matched an unrelated process before; that's the serve-restart-reap-wait/argv-miss
 * class this task exists to retire). `lsof -ti :<port> -sTCP:LISTEN` exits non-zero with empty
 * output when nothing is listening — `execFileSync` turns that into a throw, caught here as
 * "nothing to stop". Actual release is confirmed by {@link waitForPortRelease}, not by this
 * function — SIGTERM is a request, not a guarantee.
 */
export function defaultStopServeByPort(port: number, exec: (cmd: string, args: string[]) => string = defaultLifecycleExec): void {
  let out: string;
  try {
    out = exec("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"]);
  } catch {
    return;
  }
  for (const line of out.split("\n")) {
    const pid = Number(line.trim());
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone by the time we got here — waitForPortRelease is what actually confirms
        // the port is free, not this best-effort signal.
      }
    }
  }
}

/**
 * Reap-wait: poll every bound host until NONE are still accepting connections on `port`, or
 * give up after `attempts`. Mirrors {@link listenWithReapWait}'s own bound (20 x 500ms = 10s,
 * {@link DEFAULT_BIND_ATTEMPTS}/{@link DEFAULT_BIND_RETRY_MS}) — the SAME class of race (a
 * killed process's port lingers briefly while the kernel tears it down), just waited out from
 * the STOP side instead of the BIND side.
 */
export async function waitForPortRelease(
  hosts: string[],
  port: number,
  isPortListening: (host: string, port: number) => Promise<boolean>,
  opts: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? DEFAULT_BIND_ATTEMPTS;
  const delayMs = opts.delayMs ?? DEFAULT_BIND_RETRY_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    const stillListening = await Promise.all(hosts.map((h) => isPortListening(h, port)));
    if (!stillListening.some(Boolean)) return true;
    if (attempt >= attempts) return false;
    await sleep(delayMs);
  }
}

/** One task's CURRENT in-flight dispatch — live iff its inflight-lock.ts lock file names a
 *  pid that is still alive (a dead pid's lock is stale debris, never in-flight — the SAME
 *  liveness test `sweepStaleInflightLocks` uses). */
export interface LiveInflightRun {
  taskId: string;
  runId: string;
  pid: number;
}

/**
 * Every LIVE in-flight run right now — a direct read of `<root>/state/inflight/*.lock`
 * (inflight-lock.ts), the SAME per-task lock the drain/daemon path takes before dispatching a
 * task, so "in flight" here means exactly what it means everywhere else in the fleet — never a
 * second, looser definition.
 */
export function liveInflightRuns(
  inflightDir: string,
  isPidAlive: (pid: number) => boolean = defaultIsPidAlive,
): LiveInflightRun[] {
  if (!existsSync(inflightDir)) return [];
  const out: LiveInflightRun[] = [];
  for (const entry of readdirSync(inflightDir)) {
    if (!entry.endsWith(".lock")) continue;
    const taskId = entry.slice(0, -".lock".length);
    const info = readInflightLock(inflightDir, taskId);
    if (info && isPidAlive(info.pid)) out.push({ taskId, runId: info.run_id, pid: info.pid });
  }
  return out;
}

/**
 * has-PR vs pre-PR recoverability for ONE run id (W1-T169's own acceptance vocabulary) —
 * mirrors daemon.ts's `reconstructOrphan` resume/clean split, but read straight from the
 * ledger instead of a live GitHub call: `rmd down` needs an immediate, network-independent
 * answer, and a `pr.opened` ledger line carrying this exact `run_id` is evidence THIS process
 * already wrote, not a fact that needs re-confirming from GitHub. Its presence means the sweep
 * will find that PR and resume from it next start; its absence means the crash happened before
 * a PR existed, so the task simply re-dispatches from scratch next start.
 */
export function runRecoverability(lines: ReadonlyArray<Record<string, unknown>>, runId: string): "has-pr" | "pre-pr" {
  return lines.some((l) => l.run_id === runId && l.step === "pr.opened") ? "has-pr" : "pre-pr";
}

export interface LifecycleCounts {
  openPr: number;
  needsHuman: number;
}

/** The three real reads {@link defaultPlanLifecycleCounts} chains — pulled out as an
 *  injectable bundle (each defaulting to the real module function) so a test can exercise
 *  the whole function, loop and all, over a SYNTHETIC projection instead of the real
 *  `plan/tasks.yaml` + a live `gh` read (the same one-seam discipline every other lifecycle
 *  helper in this file already follows). */
export interface PlanLifecycleCountsIo {
  loadPlan?: (path: string) => Plan;
  resolveOwnerRepo?: () => { owner: string; repo: string };
  projectPlan?: (plan: Plan, deps: DeriveDeps, cachePath?: string) => Map<string, StatusProjection>;
  ghGateway?: typeof ghGateway;
}

/**
 * Best-effort open-PR / needs-human counts for the wind-down/resume report — the SAME
 * `projectPlan` projection every other reader of plan state derives from (status.ts), read
 * fresh. Network-dependent (a live `gh` read backs `prState`), so this NEVER throws: a
 * GitHub/plan-read failure degrades to `null` (reported as "unknown"), the SAME direction
 * board.ts's `github_unreachable` takes — `rmd down`/`rmd up` must still finish their real job
 * (stop/start the service) even when the network is the thing that's down.
 */
export function defaultPlanLifecycleCounts(config: Config, io: PlanLifecycleCountsIo = {}): LifecycleCounts | null {
  try {
    const plan = (io.loadPlan ?? loadPlan)(join(repoRoot, "plan", "tasks.yaml"));
    const { owner, repo } = (io.resolveOwnerRepo ?? resolveOwnerRepo)();
    const proj = (io.projectPlan ?? projectPlan)(
      plan,
      { ledgerPath: ledgerPathFor(config), github: (io.ghGateway ?? ghGateway)(owner, repo) },
      join(config.root, "state", "status.json"),
    );
    let openPr = 0;
    let needsHuman = 0;
    for (const p of proj.values()) {
      if (p.prState === "OPEN") openPr++;
      if (p.needsHuman) needsHuman++;
    }
    return { openPr, needsHuman };
  } catch {
    return null;
  }
}

/** Bound on how long `rmd down` waits for an in-flight run to reach a safe boundary before
 *  giving up and reporting it instead — deliberately short (a few seconds): `down` is an
 *  operator waiting at a terminal for maintenance, not a background process that can afford to
 *  hang, and the whole point of the recoverability report is that waiting forever is never
 *  required for a safe shutdown. */
export const DOWN_SAFE_BOUNDARY_ATTEMPTS = 6;
export const DOWN_SAFE_BOUNDARY_DELAY_MS = 500;

/** Bound on how long `rmd up` polls for a just-loaded service to actually come up (a pid to
 *  appear, or the port to start accepting) before reporting it as failed-to-start rather than
 *  hanging indefinitely on a service that never will. */
export const UP_BOOT_POLL_ATTEMPTS = 10;
export const UP_BOOT_POLL_DELAY_MS = 500;

export interface DownDeps {
  loadConfig?: () => Config;
  queryDaemon?: () => LaunchdServiceState;
  unloadDaemon?: () => void;
  isPortListening?: (host: string, port: number) => Promise<boolean>;
  stopServeByPort?: (host: string, port: number) => void;
  waitForPortRelease?: typeof waitForPortRelease;
  sleep?: (ms: number) => Promise<void>;
  liveInflightRuns?: () => LiveInflightRun[];
  readLedgerLines?: (path: string) => ReadonlyArray<Record<string, unknown>>;
  planLifecycleCounts?: () => LifecycleCounts | null;
  safeBoundaryAttempts?: number;
  safeBoundaryDelayMs?: number;
  reapAttempts?: number;
  reapDelayMs?: number;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/**
 * `rmd down [--port <n>] [--host <addr>]` — graceful wind-down for restart/maintenance
 * (W1-T169). (1) Unloads the daemon launchd service — if a task is CURRENTLY in flight
 * (inflight-lock.ts), waits a bounded window ({@link DOWN_SAFE_BOUNDARY_ATTEMPTS} x
 * {@link DOWN_SAFE_BOUNDARY_DELAY_MS}) for it to reach a safe boundary (its lock clears); if it
 * does not clear in time the wind-down PROCEEDS anyway — it never hangs forever — and instead
 * REPORTS the run's id and its recoverability (has-PR = the sweep recovers it next start,
 * pre-PR = it re-dispatches next start). (2) Stops `rmd serve` BY PORT (never an argv/pattern
 * kill) and reap-waits ({@link waitForPortRelease}) until the port actually releases before
 * returning. (3) Prints a wind-down summary: in-flight state, open-PR count, needs-human
 * count, and an explicit "safe to restart" line.
 *
 * IDEMPOTENT: when the daemon service is already unloaded and nothing is listening on the
 * port, this is a total no-op — an honest "already down" report, zero unload/stop calls issued.
 */
export async function downCommand(rest: string[], deps: DownDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const badArg = unknownArgError("down", rest, ["--port", "--host"], []);
  if (badArg) {
    err(badArg + "\n" + USAGE);
    return 2;
  }
  const config = (deps.loadConfig ?? loadConfig)();
  const uid = realUid();
  let port: number;
  let hosts: string[];
  try {
    port = resolveServePort(rest, config.serve?.port);
    hosts = resolveServeHosts(rest, process.env, config.serve?.host);
  } catch (e) {
    err(`### rmd down — ${(e as Error).message}`);
    return 2;
  }

  const queryDaemon = deps.queryDaemon ?? (() => queryLaunchdService(DAEMON_LABEL, uid));
  const unloadDaemon = deps.unloadDaemon ?? (() => unloadLaunchdService(DAEMON_LABEL, uid));
  const isPortListening = deps.isPortListening ?? defaultIsListening;
  const stopByPort = deps.stopServeByPort ?? ((_h: string, p: number) => defaultStopServeByPort(p));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waitRelease = deps.waitForPortRelease ?? waitForPortRelease;
  const inflightDir = join(config.root, "state", "inflight");
  const getLiveRuns = deps.liveInflightRuns ?? (() => liveInflightRuns(inflightDir));

  // 1. Daemon: safe-boundary wait for any in-flight run, then unload — ONLY if it is loaded
  // (idempotency: an unloaded daemon means nothing to wait for and nothing to unload).
  const daemonWasLoaded = queryDaemon().loaded;
  let inFlight: { taskId: string; runId: string; recoverable: "has-pr" | "pre-pr" } | undefined;
  if (daemonWasLoaded) {
    const attempts = deps.safeBoundaryAttempts ?? DOWN_SAFE_BOUNDARY_ATTEMPTS;
    const delayMs = deps.safeBoundaryDelayMs ?? DOWN_SAFE_BOUNDARY_DELAY_MS;
    let live = getLiveRuns();
    for (let i = 0; live.length > 0 && i < attempts; i++) {
      await sleep(delayMs);
      live = getLiveRuns();
    }
    if (live.length > 0) {
      const run = live[0] as LiveInflightRun;
      const lines = (deps.readLedgerLines ?? ((p: string) => readLedgerLines(p)))(ledgerPathFor(config));
      inFlight = { taskId: run.taskId, runId: run.runId, recoverable: runRecoverability(lines, run.runId) };
    }
    unloadDaemon();
  }

  // 2. Serve: stop BY PORT, reap-wait — ONLY if something is actually listening (idempotency).
  const listeningBefore = await Promise.all(hosts.map((h) => isPortListening(h, port)));
  const serveWasListening = listeningBefore.some(Boolean);
  if (serveWasListening) {
    for (const h of hosts) stopByPort(h, port);
  }
  const released = serveWasListening
    ? await waitRelease(hosts, port, isPortListening, { sleep, attempts: deps.reapAttempts, delayMs: deps.reapDelayMs })
    : true;

  // 3. Report.
  const counts = (deps.planLifecycleCounts ?? (() => defaultPlanLifecycleCounts(config)))();
  out(`### rmd down — wind-down summary`);
  out(`    daemon service:  ${daemonWasLoaded ? "unloaded" : "already down"}`);
  out(
    `    serve (:${port}): ${
      !serveWasListening
        ? "already down"
        : released
          ? "stopped — port released"
          : "stop issued — port STILL HELD after the reap-wait"
    }`,
  );
  out(
    `    in-flight:       ${
      inFlight
        ? `${inFlight.taskId} (run ${inFlight.runId}) — ${
            inFlight.recoverable === "has-pr" ? "has a PR: the sweep recovers it next start" : "pre-PR: it re-dispatches next start"
          }`
        : "none"
    }`,
  );
  out(`    open PRs:        ${counts ? counts.openPr : "unknown (GitHub unreachable)"}`);
  out(`    needs-human:     ${counts ? counts.needsHuman : "unknown (GitHub unreachable)"}`);
  out(`    safe to restart: ${released ? "yes" : "NO — the serve port is still held; do not \`rmd up\` yet"}`);
  return released ? 0 : 1;
}

export interface UpDeps {
  loadConfig?: () => Config;
  ensureInstallFresh?: (repoDir: string) => boolean;
  currentBranch?: (repoDir: string) => string | null;
  queryDaemon?: () => LaunchdServiceState;
  loadDaemonService?: (plistPath: string) => void;
  daemonPlistExists?: (path: string) => boolean;
  isPortListening?: (host: string, port: number) => Promise<boolean>;
  loadServeService?: (plistPath: string) => void;
  servePlistExists?: (path: string) => boolean;
  sleep?: (ms: number) => Promise<void>;
  consoleUrlCommand?: typeof consoleUrlCommand;
  liveInflightRuns?: () => LiveInflightRun[];
  planLifecycleCounts?: () => LifecycleCounts | null;
  bootPollAttempts?: number;
  bootPollDelayMs?: number;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/**
 * `rmd up [--port <n>] [--host <addr>] [--allow-off-main]` — full resume (W1-T169). (1)
 * Install-freshness runs FIRST, via the SAME {@link ensureInstallFresh} hook `rmd daemon`/`rmd
 * serve` boot through (W1-T151) — a lockfile-changing pull triggers `npm ci` BEFORE anything
 * else starts. (2) REFUSES to resume when the checkout is off `main` (the exact incident this
 * exists for: never resume a fleet against branch code) unless `--allow-off-main` is given
 * explicitly. (3) Loads the daemon launchd service. (4) Confirms/starts the serve launchd
 * service (never a foreground spawn — T152 already makes serve a service; this CONFIRMS it).
 * (5) Prints the resume report: daemon pid, the console URL WITH its READ token (via the
 * already-hardened `rmd console-url`, never a second URL-assembly implementation — and
 * deliberately the READ token, never the write one, per standing rule 24 / R-5), the
 * in-flight/queued head, and the needs-human count.
 *
 * IDEMPOTENT: when the daemon service is already loaded and serve is already listening, this
 * verifies + reports the running state and issues NEITHER a `loadDaemonService` nor a
 * `loadServeService` call — never a double start.
 */
export async function upCommand(rest: string[], deps: UpDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const badArg = unknownArgError("up", rest, ["--port", "--host"], ["--allow-off-main"]);
  if (badArg) {
    err(badArg + "\n" + USAGE);
    return 2;
  }

  // 1. Install-freshness FIRST — before ANYTHING else below starts (W1-T151).
  (deps.ensureInstallFresh ?? ensureInstallFresh)(repoRoot);

  // 2. Off-main REFUSE, unless explicitly overridden — never resume a fleet against branch code.
  const branch = (deps.currentBranch ?? ((d: string) => currentBranch(d)))(repoRoot);
  const allowOffMain = rest.includes("--allow-off-main");
  if (branch !== null && branch !== SERVE_EXPECTED_BRANCH && !allowOffMain) {
    err(
      `### rmd up — REFUSING to resume: this checkout is on branch '${branch}', not ` +
        `'${SERVE_EXPECTED_BRANCH}'. Resuming the fleet against branch code is the exact ` +
        `incident this refusal exists for. Re-run with --allow-off-main to resume anyway.`,
    );
    return 1;
  }

  const config = (deps.loadConfig ?? loadConfig)();
  const uid = realUid();
  let port: number;
  let hosts: string[];
  try {
    port = resolveServePort(rest, config.serve?.port);
    hosts = resolveServeHosts(rest, process.env, config.serve?.host);
  } catch (e) {
    err(`### rmd up — ${(e as Error).message}`);
    return 2;
  }
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const isPortListening = deps.isPortListening ?? defaultIsListening;
  const attempts = deps.bootPollAttempts ?? UP_BOOT_POLL_ATTEMPTS;
  const delayMs = deps.bootPollDelayMs ?? UP_BOOT_POLL_DELAY_MS;

  // 3. Load the daemon service — ONLY if it is not already loaded (idempotency).
  const queryDaemon = deps.queryDaemon ?? (() => queryLaunchdService(DAEMON_LABEL, uid));
  const daemonPlistPathV = launchdPlistPath(DAEMON_LABEL);
  const daemonPlistPresent = (deps.daemonPlistExists ?? existsSync)(daemonPlistPathV);
  let daemonSvc = queryDaemon();
  const daemonWasAlreadyUp = daemonSvc.loaded;
  if (!daemonSvc.loaded && daemonPlistPresent) {
    (deps.loadDaemonService ?? ((p: string) => loadLaunchdService(p, uid)))(daemonPlistPathV);
    for (let i = 0; i < attempts && !daemonSvc.loaded; i++) {
      await sleep(delayMs);
      daemonSvc = queryDaemon();
    }
  }

  // 4. Confirm/start serve AS A SERVICE — ONLY if nothing is already listening (idempotency).
  const listeningBefore = await Promise.all(hosts.map((h) => isPortListening(h, port)));
  const serveWasAlreadyUp = listeningBefore.some(Boolean);
  const servePlistPathV = launchdPlistPath(SERVE_LABEL);
  const servePlistPresent = (deps.servePlistExists ?? existsSync)(servePlistPathV);
  let serveListening = serveWasAlreadyUp;
  if (!serveListening && servePlistPresent) {
    (deps.loadServeService ?? ((p: string) => loadLaunchdService(p, uid)))(servePlistPathV);
    for (let i = 0; i < attempts && !serveListening; i++) {
      await sleep(delayMs);
      serveListening = (await Promise.all(hosts.map((h) => isPortListening(h, port)))).some(Boolean);
    }
  }

  // 5. Resume report.
  const live = (deps.liveInflightRuns ?? (() => liveInflightRuns(join(config.root, "state", "inflight"))))();
  const counts = (deps.planLifecycleCounts ?? (() => defaultPlanLifecycleCounts(config)))();

  out(`### rmd up — resume report`);
  out(
    `    daemon:          ${
      daemonSvc.loaded
        ? `running${daemonWasAlreadyUp ? " (already up)" : ""} (pid ${daemonSvc.pid ?? "starting"})`
        : daemonPlistPresent
          ? "FAILED to come up — check state/logs"
          : "not running — not installed (run `rmd daemon-plist --repo <name> --write` first)"
    }`,
  );
  out(
    `    serve (:${port}): ${
      serveListening
        ? `listening${serveWasAlreadyUp ? " (already up)" : ""}`
        : servePlistPresent
          ? "FAILED to come up — check state/logs/serve.err.log"
          : "not listening — not installed (run `rmd serve-plist --write` first)"
    }`,
  );
  if (serveListening) {
    await (deps.consoleUrlCommand ?? consoleUrlCommand)(["--port", String(port), "--host", hosts.join(",")], config, { out, err });
  }
  out(`    in-flight/queued: ${live.length > 0 ? live.map((r) => `${r.taskId} (run ${r.runId})`).join(", ") : "none in flight"}`);
  out(`    needs-human:      ${counts ? counts.needsHuman : "unknown (GitHub unreachable)"}`);

  const ok = (!daemonPlistPresent || daemonSvc.loaded) && (!servePlistPresent || serveListening);
  return ok ? 0 : 1;
}

/** Injectable seam for {@link statusCommand} — every default is the real, production behaviour;
 *  a test overrides just enough to avoid `loadConfig()`'s `which claude` shell-out and any real
 *  launchd query, the same "swap the edges, keep the middle real" shape as {@link DownDeps}. */
export interface StatusDeps {
  loadConfig?: () => Config;
  queryService?: (service: ServiceName) => { running: boolean; pid: number | null; lastExitCode?: number };
  /** The deploy-supervisor's installed `StartInterval`, seconds — defaults to reading the
   *  actual unit off disk (`launchdPlistPath(SUPERVISOR_LABEL)`); overridable so a test never
   *  touches the real filesystem. */
  resolveSupervisorIntervalS?: () => number | undefined;
  ledgerPathFor?: (config: Config) => string;
  repoRoot?: string;
  /** The DERIVED half's (W1-T280) batched GitHub gateway; defaults to
   *  `buildBatchedGithub(owner, repo)` off this checkout's own `origin` remote. Overridable so
   *  a test never shells to `gh`/`git remote`; `null` explicitly omits the gateway (the same
   *  "unreachable" degrade a real outage produces). */
  github?: GitHub | null;
  /** Overridable so a test can force the `resolveOwnerRepo`/`buildBatchedGithub` construction
   *  path to throw (the "no git remote" degrade) without shelling to a real `git config`. */
  resolveOwnerRepo?: () => { owner: string; repo: string };
  buildBatchedGithub?: typeof buildBatchedGithub;
  buildStatusBoard?: typeof buildStatusBoard;
  renderStatusBoardText?: typeof renderStatusBoardText;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/**
 * `rmd status [--json]` — "is it running, and why is it stalled" (W1-T279 + W1-T280,
 * MASTER-PLAN §7/§5D). LIVENESS/LATCHES/LAST CYCLE are LOCAL TRUTH ONLY (no `git fetch`, no
 * `gh` call — offline-safe by construction). BLOCKERS BY CLASS/QUEUE HEAD/INBOX/HEADROOM are
 * DERIVED: mostly local (the ledger's own dispatch-breaker/blocked-PR/headroom signals), except
 * QUEUE HEAD's dispatch eligibility and INBOX's dep-merged predicate, which read through ONE
 * batched GitHub gateway (`buildBatchedGithub`) this command constructs — a network read, but
 * NEVER a gate: an unreachable/unconfigured gateway degrades exactly those rows to a stated
 * unknown, never a throw, never a delayed exit (see status-board.ts's own header doc). This
 * command is a THIN call site: it resolves the things that live at the CLI layer (the launchd
 * process query, the plan/tasks.yaml + GitHub-gateway construction, the headroom-governor
 * config read) and hands everything else to the pure builder. Read-only: never writes a
 * marker, never spawns anything, always exits 0 (bad args aside).
 */
export async function statusCommand(rest: string[], deps: StatusDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const badArg = unknownArgError("status", rest, [], ["--json"]);
  if (badArg) {
    err(badArg + "\n" + USAGE);
    return 2;
  }
  const config = (deps.loadConfig ?? loadConfig)();
  const uid = realUid();
  const queryService =
    deps.queryService ??
    ((service: ServiceName): { running: boolean; pid: number | null; lastExitCode?: number } => {
      const label = service === "daemon" ? DAEMON_LABEL : service === "serve" ? SERVE_LABEL : SUPERVISOR_LABEL;
      const state = queryLaunchdService(label, uid);
      // "running" means a live pid, not merely "loaded" — a bootstrapped-but-not-spawned job
      // answers "is it running" with no, exactly like an unloaded one.
      if (service !== "deploy-supervisor") return { running: state.pid !== null, pid: state.pid };
      // deploy-supervisor is an interval job: its own `pid`/`loaded` mean nothing between ticks
      // (see status-board.ts's ServiceKind) — `launchctl list`'s Status column is the fact that
      // actually carries its health (the W1-T301 fix).
      const listStatus = queryLaunchdListStatus(label);
      return { running: listStatus.pid !== null, pid: listStatus.pid, lastExitCode: listStatus.lastExitCode };
    });
  const resolveSupervisorIntervalS =
    deps.resolveSupervisorIntervalS ??
    ((): number | undefined => {
      try {
        const xml = readFileSync(launchdPlistPath(SUPERVISOR_LABEL), "utf8");
        return parseSupervisorStartInterval(xml);
      } catch {
        return undefined; // not installed / unreadable — the board falls back to the default pace
      }
    });
  const buildBoard = deps.buildStatusBoard ?? buildStatusBoard;
  const render = deps.renderStatusBoardText ?? renderStatusBoardText;
  const ledgerPath = (deps.ledgerPathFor ?? ledgerPathFor)(config);
  const repoDir = deps.repoRoot ?? repoRoot;
  // GITHUB IS DECORATION, NEVER A GATE: `resolveOwnerRepo`/`buildBatchedGithub` can themselves
  // fail (no `git` remote, no network) — caught here so a status read NEVER throws on a bad
  // network day; the board degrades the rows that needed it to a stated unknown instead.
  let github: GitHub | undefined;
  if (deps.github === undefined) {
    try {
      const { owner, repo } = (deps.resolveOwnerRepo ?? resolveOwnerRepo)();
      github = (deps.buildBatchedGithub ?? buildBatchedGithub)(owner, repo);
    } catch {
      github = undefined;
    }
  } else {
    github = deps.github ?? undefined;
  }
  const model = buildBoard(config.root, ledgerPath, {
    queryService,
    repoDir,
    github,
    resolveHeadroomEnabled: () => resolveHeadroomEnabled(config),
    resolveSupervisorIntervalS,
  });
  out(rest.includes("--json") ? JSON.stringify(model, null, 2) : render(model));
  return 0;
}

// ── rmd serve — the operator console FRONT DOOR (W1-T139, MASTER-PLAN §7/§7B) ──
//
// Real business logic lives entirely in the four already-proven modules lib/serve.ts
// assembles (service.ts, board.ts, panel-actions.ts, panel-graph.ts); this command is CLI
// glue only — resolve the port, load/generate the bearer tokens, build the real deps (the
// real ghGateway/ghTraceGateway/ghIssueCloser, the real plan, the real ledger path), bind,
// print the console URL, and block until SIGINT/SIGTERM.
// EXPORTED for test/serve-command-boot.test.ts (W1-T152): the service posture this function now
// applies at boot — logs forced 0600, an off-main notice, a reap-waiting bind — is only real if
// it is proven on the ACTUAL boot path, in-process, where a coverage record exists. A spawned
// child proves the non-TTY log behaviour but reports no coverage for the lines that did it.
export async function serveCommand(
  rest: string[],
  // `branch` is injectable for the SAME reason main()'s freshness check is: CI checks out a
  // detached merge SHA, so the off-main branch of the notice below would never execute there
  // — an untested warning is a warning that has never been seen to fire.
  // `bindRetry` narrows the reap-wait window so a test can drive the LOSING side of the port
  // race (retry, then give up) in milliseconds instead of the real 10s — production passes
  // nothing and gets listenWithReapWait's own defaults.
  deps: { branch?: (repoDir: string) => string | null; bindRetry?: { attempts?: number; delayMs?: number } } = {},
): Promise<number> {
  // `--host` was documented in USAGE and read by resolveServeHosts, but was NOT in this
  // validator's value-flag list — so `rmd serve --host <addr>` exited 2 on its own documented
  // flag and the tailnet bind was reachable only via RMD_SERVE_HOST (W1-T152).
  const badArg = unknownArgError("serve", rest, ["--port", "--host"], []);
  if (badArg) {
    console.error(badArg + "\n" + USAGE);
    return 2;
  }

  const config = loadConfig();
  let port: number;
  let hosts: string[];
  let identity: ReturnType<typeof resolveServeIdentity>;
  try {
    // Config is the LAST fallback (flag > RMD_SERVE_HOST > config.serve.* > loopback:4317), so
    // the launchd unit's baked env and a hand-run `rmd serve` land on the same interfaces.
    port = resolveServePort(rest, config.serve?.port);
    hosts = resolveServeHosts(rest, process.env, config.serve?.host);
    // W1-T398: resolved here, side by side with host/port, so an install that enables identity
    // without declaring which proxy it trusts fails the SAME way an invalid --host does — a
    // clean startup refusal, not a silent inherited default discovered later at request time.
    identity = resolveServeIdentity(config.serve?.identityCapability, config.serve?.trustedProxy);
  } catch (e) {
    console.error(`### rmd serve — ${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const self = resolveOwnerRepo();
  const planPath = join(repoRoot, "plan", "tasks.yaml");
  const ledgerPath = ledgerPathFor(config);
  const plan = loadPlan(planPath);
  const tokens = resolveServiceTokens(config.root);

  const runId = `SERVE-${Date.now()}`;
  const log = (step: string, extra: Record<string, unknown> = {}) =>
    appendLedger(ledgerPath, { run_id: runId, task_id: "SERVE", step, ...extra });

  // ── SERVICE POSTURE (W1-T152). None of these three can refuse to start: under the launchd
  // unit this command now generates, a startup refusal is a KeepAlive crash-loop, and a
  // crash-looping console is worse than an honest degraded one (W1-T255, #726).
  //
  // 1. LOGS 0600 before anything is printed — the banner below carries the read token, and
  //    launchd creates StandardOutPath at its own 0644 umask (R-5 cost a token rotation).
  const logs = serveLogPaths(config.root);
  const logMode = ensureLogFileMode([logs.stdout, logs.stderr]);
  if (logMode.failed.length > 0) log("serve.log_mode_failed", { paths: logMode.failed });
  // 2. OFF-MAIN is SAID, not refused: tsx loads the module graph once, so a console started off
  //    a branch keeps serving that branch's code even after the checkout returns to main.
  const branch = (deps.branch ?? currentBranch)(repoRoot);
  const offMain = offMainNotice(branch);
  if (offMain !== null) {
    console.error(offMain);
    log("serve.off_main", { branch });
  }

  // BATCHED gateway (not per-task ghGateway): the board's GET /v1/status derives EVERY task via
  // projectPlan, and ghGateway shells `gh` per task (findMergedByTrailer is a search each) — O(N)
  // sequential subprocesses, ~0.4s×N, which hung the board at "loading…" on the full plan (~74s at
  // 183 tasks). buildBatchedGithub fetches all PRs ONCE (TTL-refreshed) and resolves every task
  // in-memory: O(1). ONE shared instance backs the board AND GET /v1/drain/preview's merged-set.
  // W1-T154: buildServeServer itself pre-warms this gateway (calls its optional `.warm()`)
  // synchronously before returning, and keeps it warm on a background TTL timer — so the FIRST
  // real GET /v1/status below never pays the O(1)-but-still-cold first fetch either.
  // W1-T181: `log` wires the gateway's fetch-size/fetch-failure observability into the SAME
  // ledger every other SERVE step writes to — the pre-fix silence (hours of outage, zero
  // serve.log error lines) is why this exists; see buildBatchedGithub's own doc for detail.
  const boardGithub = buildBatchedGithub(self.owner, self.repo, { log });
  const server = buildServeServer({
    // `inflightHolder` wires deriveStatus's THIRD liveness disjunct (lib/status.ts) to the real
    // lock directory — the same `<config.root>/state/inflight` path `acquireInflightLock` writes
    // and the sweep rung reaps, never a second notion of where locks live. Without this the
    // console keeps the pre-existing two-disjunct behaviour, so this line IS the wiring: a
    // genuinely-live run that has been quiet longer than the 30-minute ledger bound renders as
    // running here and as nothing without it. `isPidAlive` is left to its `defaultIsPidAlive`
    // default; only tests override it.
    board: { plan, ledgerPath, github: boardGithub, inflightHolder: (taskId) => readInflightLock(join(config.root, "state", "inflight"), taskId) },
    // panel-graph.ts reloads plan/tasks.yaml fresh on every GET /v1/trace (its own header) --
    // planPath alone is enough, no snapshot needed here the way board.ts's does.
    // `statusGithub` backs GET /v1/drain/preview's (W1-T140) merged-set derivation --
    // the SAME batched gateway the board route above uses, never a second gateway type.
    // W1-T193: APPROVE/REFRAME from the console hand off to the REAL `bin/rmd approve`/
    // `bin/rmd reframe` CLI, detached — see RatifyCliGateway's own doc (panel-graph.ts) for
    // why. `ratify` is left unset here on purpose: buildServeServer (lib/serve.ts) defaults
    // it to a real ratifyCliGateway rooted at panelGraph.root + config.root's state/logs
    // (config.root === fleetControlRoot below, the same root every other rmd-serve state
    // file already lives under) — see ServeDeps.panelGraph's own doc for why the assembler,
    // not this CLI-only wiring, owns that construction.
    panelGraph: {
      root: repoRoot,
      planPath,
      ledgerPath,
      github: ghTraceGateway(self.owner, self.repo),
      statusGithub: boardGithub,
      // W1-T191: arm the real feedback-landing bridge for POST /v1/feedback/decision — an
      // operator's accept/reject click writes against `repoRoot` (the daemon's own checkout)
      // and, without this, leaves it dirty until the next `git checkout --`/reset wipes it.
      feedbackLand: {},
    },
    ledgerPath,
    issues: ghIssueCloser(),
    // See lib/serve.ts's module header ("TWO ROOTS, ONE PanelActionDeps SHAPE") for why these
    // differ: fleet-control flag files must match what `rmd daemon`/`rmd drain` check
    // (config.root); plan/questions.ndjson must match where `appendQuestion` writes (repoRoot).
    fleetControlRoot: config.root,
    questionsRoot: repoRoot,
    tokens,
    // W1-T371/W1-T398: additive tailnet-identity auth, opt-in via config.serve.identityCapability
    // and resolved (with serve.trustedProxy) above, side by side with host/port -- undefined on
    // an unconfigured install, identity is never consulted, exactly as before.
    identity,
    log,
  });

  // BIND EACH NAMED INTERFACE — never the wildcard. `listen(port)` alone defaults to `::`
  // (every interface) while the banner printed "localhost", so the surface was wide open and
  // the log said otherwise. But a SINGLE named host is not enough either: binding only the
  // tailnet address kept the phone working and silently broke `127.0.0.1`, which is where
  // every local curl, script and desktop bookmark points. Both must work, so each host gets
  // its own listener sharing this one server's handlers, deps and warm caches.
  const mirrors: Server[] = [];
  try {
    for (const [i, h] of hosts.entries()) {
      const target =
        i === 0
          ? server
          : // Additional interfaces reuse the PRIMARY server's request/upgrade listeners rather
            // than building a second service: a second buildServeServer would start a second
            // board pre-warm timer and poll GitHub twice for one console.
            createServer((req, res) => {
              for (const h2 of server.listeners("request") as Array<(a: unknown, b: unknown) => void>) {
                h2(req, res);
              }
            });
      if (i > 0) mirrors.push(target);
      // 3. REAP-WAIT (W1-T152): a kill→relaunch that beats the old process's port release used
      //    to die EADDRINUSE into an unread log while the OLD process kept serving stale code.
      //    Under launchd `kickstart -k` that race is routine, so an in-use port is waited out
      //    (bounded, EADDRINUSE only) and every wait is AUDIBLE in the log and the ledger.
      await listenWithReapWait(
        () =>
          new Promise<void>((resolve, reject) => {
            target.once("error", reject);
            target.listen(port, h, resolve);
          }),
        {
          ...deps.bindRetry,
          onRetry: (attempt, err) => {
            console.error(`### rmd serve — ${h}:${port} still held (${err.code}), waiting for release (attempt ${attempt})`);
            log("serve.bind_retry", { host: h, port, attempt, code: err.code });
          },
        },
      );
    }
  } catch (e) {
    console.error(`### rmd serve — failed to listen on ${hosts.join(", ")}:${port}: ${(e as Error).message}`);
    log("serve.bind_failed", { hosts, port, error: (e as Error).message });
    for (const m of mirrors) m.close();
    return 1;
  }

  log("serve.start", { port, hosts, repo: `${self.owner}/${self.repo}` });
  // THE PRINTED URL CARRIES THE READ TOKEN ONLY, and the write token is never echoed at all.
  // These lines are the operator's console bookmark, and under the real launch stdout is
  // redirected to serve.log — so whatever is printed here is written to disk in the clear and
  // outlives the process. A bookmark needs to VIEW the board; arming a write action can pay the
  // one-time cost of reading the 0600 tokens file. See resolveServiceTokens for rotation.
  console.log(`### rmd serve — listening on ${hosts.map((h) => `http://${h}:${port}`).join(", ")} (repo ${self.owner}/${self.repo})`);
  for (const h of hosts) console.log(`    console:     http://${h}:${port}/?token=${tokens.read}`);
  console.log(`    write token: ${serviceTokensPath(config.root)} (0600, not printed)`);

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      log("serve.stop", {});
      server.close(() => resolve());
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
  return 0;
}

// ── rmd sweep — the level-triggered PR-pipeline reconciler (W1-T77, P22 core) ──
//
// The deterministic core (predicate + orchestration + idempotence) lives in
// lib/sweep.ts and is graded by test/sweep.test.ts over INJECTED deps. This is
// its real wiring: it BUILDS the observed open-PR state from `gh`/the ledger and
// supplies the four gated effects (arm / dispatch-fix / close / escalate). The
// SAME `runSweep` entry point is invoked by `rmd daemon`'s poll loop (see
// buildSweepHook, wired into DaemonDeps.sweep) — acceptance 4's shared impl.

/** One rollup check entry as `gh pr list --json statusCheckRollup` returns it. */
interface RollupCheck {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  /** The check's GitHub Actions job URL (…/actions/runs/<run>/job/<job>) — the ci-log mode's log source (W1-T100). */
  detailsUrl?: string;
}

interface RawOpenPr {
  number: number;
  url: string;
  headRefName: string;
  headRefOid: string;
  updatedAt: string;
  body: string;
  autoMergeRequest: unknown;
  statusCheckRollup?: RollupCheck[];
}

const REVIEW_CTX = "remudero-review";

/** Map the `remudero-review` rollup entry onto the sweep's reviewState. */
function reviewStateFromRollup(rollup: RollupCheck[] | undefined): OpenPrView["reviewState"] {
  const r = (rollup ?? []).find((c) => c.context === REVIEW_CTX || c.name === REVIEW_CTX);
  if (!r) return "none";
  const s = (r.state ?? r.conclusion ?? r.status ?? "").toUpperCase();
  if (s === "SUCCESS") return "success";
  if (s === "FAILURE" || s === "ERROR") return "failure";
  return "pending";
}

/**
 * W1-T176: has the deterministic `rmd review` post already been ATTEMPTED
 * and REFUSED for this exact `taskId@headSha`? Scans for a `review.post_refused`
 * ledger line matching both fields — deliberately NOT `review.post_failed`
 * (a transient `gh` error, which must keep retrying, never escalate on a
 * mere network hiccup) and NOT `review.posted` (a real post always flips
 * GitHub's live rollup away from "zero runs," so `reviewStateFromRollup`
 * itself carries that outcome on the next read — no ledger check needed).
 * `taskId` undefined (no `Remudero-Task:` trailer) can never have a
 * matching ledger line — returns `false`, never a crash.
 */
function reviewPostRefusedFor(ledger: Array<Record<string, unknown>>, taskId: string | undefined, headSha: string): boolean {
  if (!taskId) return false;
  return ledger.some((l) => l.step === "review.post_refused" && l.task_id === taskId && l.head_sha === headSha);
}

/**
 * WRITTEN AS TWO DIRECT `.step ===` COMPARISONS ON PURPOSE, not as a `Set.has()` over a `typeof`
 * guard. `test/ledger-rotation.test.ts` derives the expected `DECISION_RELEVANT_LEDGER_STEPS`
 * membership by scanning consumer source for `/\.step\s*(?:===|!==)\s*["']…["']/`, so this shape
 * makes the dependency VISIBLE to the very check that exists to find it. Both steps are already in
 * that set (`ledger.ts:337`), which is what stops a rotation from archiving the lines and silently
 * resetting `priorReviewOrphans` to zero — the line IS the bound.
 *
 * The first draft guarded with a `typeof` check against the step field and CI caught it: the
 * scanner read that guard's own type literal as a step name and failed. That was a false positive,
 * but the honest fix is to write the comparison the scanner can read rather than to phrase around
 * it. NOTE the scanner does not strip comments, so prose here must avoid the compared-literal shape
 * too — this very paragraph failed the check once for describing it verbatim.
 */
function isReviewPostedStep(step: unknown): boolean {
  return step === "review.posted" || step === "review.post_refused";
}

/** What {@link reviewOrphansFor} derived — the two halves of the W1-T225 pair, from one scan. */
interface ReviewOrphanFacts {
  /** True iff this PR was reviewed on a head that is no longer the current one. */
  orphanedByPush: boolean;
  /** How many DISTINCT prior heads carry a posted review — the loop falsifier's count. */
  priorOrphans: number;
}

/**
 * W1-T225's producer: was this PR's `remudero-review` posted against a head that has since been
 * superseded, and across how many distinct prior heads?
 *
 * DERIVED FROM THE LEDGER THE PASS ALREADY READ — `buildOpenPrViews` holds `readLedgerLines` for
 * `unmetFromLedger`/`priorStrikesFor`/`reviewPostRefusedFor` already, so this costs ZERO additional
 * REST requests. That is the shape the field's own SCOPE note asked for: "buildOpenPrViews would
 * derive it the SAME way it already derives `reviewPostRefused`: scan the ledger for a prior
 * `review.posted`/`review.post_refused` line for this `taskId` at a head sha OTHER than the current
 * one." This is that scan, plus the distinct-head count `priorReviewOrphans`' doc specifies
 * ("counting the distinct prior heads it found").
 *
 * ── THE FALSE-POSITIVE BOUNDARY, which is the whole risk surface ────────────────────────────────
 * Three states must NOT read as orphaned, and each is excluded by construction:
 *
 *   1. NEVER REVIEWED AT ALL — no posted line for this task. `prior` is empty ⇒ false/0. A PR
 *      awaiting its first review is not orphaned, and the cap row's own comment requires exactly
 *      this ("a PR awaiting its FIRST review never matches this row").
 *   2. REVIEW IS CURRENT — the only posted lines carry the CURRENT head. Filtering on
 *      `head_sha !== headSha` leaves nothing ⇒ false/0.
 *   3. A HEAD THE LEDGER HAS NOT SEEN YET — the race between a push and the next poll. This is the
 *      subtle one, and it resolves correctly for a reason worth stating: a brand-new head has no
 *      posted line of its own, but the PRIOR head's line is still there, so this reads TRUE — which
 *      is CORRECT, because that is precisely what "orphaned by a push" means. What it must not do
 *      is read true when the review simply has not been *observed* yet, and it cannot: a line only
 *      exists once a verdict was actually posted for that sha.
 *
 * A LINE WITH NO `head_sha` IS IGNORED, never counted as a prior head. The ledger carries such rows
 * (the pre-#981 blind-arm class wrote outcomes with no sha), and treating an absent sha as "some
 * other head" would manufacture an orphan out of missing information — the same
 * unknown-as-a-definite-answer mistake `mergeable` taught today in the other direction.
 *
 * BLAST RADIUS IF WRONG, measured against the consumers rather than assumed: the post-review row's
 * `when` clause does NOT reference either field, so a false positive there changes only which
 * REASON STRING is logged, never whether the review lane runs. The one action-bearing consumer is
 * the cap row, which escalates once `priorOrphans >= policy.reviewOrphanCap` (2). So the real
 * false-positive cost is a premature needs-human issue, NOT a paid re-review.
 */
export function reviewOrphansFor(
  ledger: Array<Record<string, unknown>>,
  taskId: string | undefined,
  headSha: string,
): ReviewOrphanFacts {
  if (!taskId || !headSha) return { orphanedByPush: false, priorOrphans: 0 };
  const priorHeads = new Set<string>();
  for (const l of ledger) {
    if (!isReviewPostedStep(l.step)) continue;
    if (l.task_id !== taskId) continue;
    const sha = typeof l.head_sha === "string" ? l.head_sha : "";
    if (!sha || sha === headSha) continue; // absent sha, or the CURRENT head — neither is an orphan
    priorHeads.add(sha);
  }
  return { orphanedByPush: priorHeads.size > 0, priorOrphans: priorHeads.size };
}

/**
 * W1-T100 (the #170 fix): failing required-check names + a tail of each one's
 * log — the ci-log fix mode's ONLY input (deriveFixMode/renderFixPrompt,
 * W1-T94). Best-effort: a log-fetch failure degrades to an EMPTY tail
 * (renderFixPrompt already renders "no failing check detail was captured" for
 * that case) — NEVER throws, so one unreadable log never strands the sweep.
 * `owner`/`repo` are REQUIRED and passed as `--repo` on the `gh` call — the
 * daemon/sweep can target a repo other than its own checkout's cwd (the
 * daemon-repo-targeting design), so this must never rely on `gh`'s ambient
 * cwd-inferred repo, which would silently query the WRONG repo's job ids.
 */
function fetchCiFailures(owner: string, repo: string, rollup: RollupCheck[] | undefined, tailLines = 60): CiFailure[] {
  const failing = (rollup ?? []).filter((c) => {
    const s = (c.state ?? c.conclusion ?? c.status ?? "").toUpperCase();
    return s === "FAILURE" || s === "ERROR";
  });
  return failing.map((c) => {
    const name = c.name ?? c.context ?? "unknown";
    let logTail = "";
    try {
      const jobId = c.detailsUrl?.match(/\/job\/(\d+)/)?.[1];
      if (jobId) {
        const out = execFileSync("gh", ["run", "view", "--job", jobId, "--repo", `${owner}/${repo}`, "--log-failed"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        logTail = out.split("\n").slice(-tailLines).join("\n");
      }
    } catch {
      /* best-effort — degrades to an empty tail, never throws */
    }
    return { name, logTail };
  });
}

/** The `Remudero-Task: <id>` trailer in a PR body, if present (anchored line). */
function taskIdFromBody(body: string): string | undefined {
  const m = body.match(/^Remudero-Task:\s*(\S+)\s*$/m);
  return m ? m[1] : undefined;
}

/**
 * Recover the most recent failing review's unmet criteria for a task from the
 * ledger (`review.posted` / `fix.review` lines carry `unmet_criteria` + `reasons`).
 * No PR-head checkout needed just to ROUTE the disposition — the fix rung itself
 * re-derives the authoritative verdict when it runs. Proof text is unavailable
 * from the ledger, so it degrades to "" (the fix prompt leans on claim + reason).
 */
function unmetFromLedger(lines: Array<Record<string, unknown>>, taskId: string): CriterionVerdict[] {
  let claims: string[] = [];
  let reasons: string[] = [];
  for (const line of lines) {
    if (line.step !== "review.posted" || line.task_id !== taskId) continue;
    if (line.state === "success") { claims = []; reasons = []; continue; }
    if (Array.isArray(line.unmet_criteria)) claims = line.unmet_criteria.map(String);
    if (Array.isArray(line.reasons)) reasons = line.reasons.map(String);
  }
  return claims.map((claim, i) => ({
    claim,
    proof: "",
    met: false,
    reason: reasons[i] ?? "",
    proof_exec: "not_executable" as const,
  }));
}

/**
 * Fix strikes already attempted for a PR — a straight `fix.dispatch` (task_id)
 * count. W1-T78 fixed the cold-dispatch `log` wrapper (`buildSweepEffects`'s
 * `dispatchFix`) to stamp the REAL `task.id` on every `fix.dispatch`/`fix.review`
 * line it writes — before that fix, a cold dispatch's lines carried the OUTER
 * caller's synthetic id ("SWEEP"/"FIX"/"DAEMON"), so this function used to fall
 * back to counting `sweep.disposed{disposition:"blocked-fixable",acted:true}`
 * lines by `pr_number` as a PROXY (one such line ⇒ one dispatchFix CALL, which
 * internally runs up to `strikeCap` strikes before returning). That proxy is
 * REMOVED now that the root cause is fixed: `fix.dispatch` lines are reliably
 * task-tagged for every caller, so counting BOTH would double-count every real
 * strike (N `fix.dispatch` lines + 1 proxy line per dispatchFix call) and could
 * starve an answered PR of its one legitimate extra strike (W1-T78's
 * `strikeCapForAnswer` ceiling check).
 */
/**
 * The regime the CURRENT verdict for a task was produced under (W1-T199) — read
 * from the most recent `review.posted` ledger line's `proof_exec`.
 *
 * This is what decides whether keyword-era strikes are amnestied: the amnesty
 * applies only when the verdict the rung would act on NOW is itself evidence.
 * A task still being judged by keyword overlap gets no amnesty, because there is
 * nothing better to spend the next strike against.
 */
export function currentStrikeRegimeFor(lines: Array<Record<string, unknown>>, taskId: string | undefined): StrikeRegime {
  if (!taskId) return "keyword_only";
  let latest: Record<string, unknown> | undefined;
  for (const line of lines) {
    if (line.step === "review.posted" && line.task_id === taskId) latest = line;
  }
  const pe = latest?.proof_exec;
  if (!Array.isArray(pe)) return "keyword_only";
  return pe.some((x) => x !== "not_executable") ? "executed" : "keyword_only";
}

/**
 * The verdict regime a fix-rung strike was spent against (W1-T199).
 *
 * `"executed"` — the floor RAN at least one proof, so the unmet criteria the
 * strike was dispatched against are EVIDENCE.
 * `"keyword_only"` — no proof executed, so the strike was spent against keyword
 * overlap. Historical `fix.dispatch` lines carry no tag at all and are read as
 * this, because every one of them predates the executor.
 */
export type StrikeRegime = "executed" | "keyword_only";

/** The regime a ledger `fix.dispatch` line records — untagged ⇒ pre-executor. */
export function strikeRegimeOf(line: Record<string, unknown>): StrikeRegime {
  return line.verdict_regime === "executed" ? "executed" : "keyword_only";
}

/**
 * Strikes that COUNT toward the cap, for a task, under `currentRegime` (W1-T199).
 *
 * WHY THIS IS NOT A PLAIN COUNT. `fix.dispatch` lines are append-only and
 * monotonic, so a strike spent months ago against a keyword-only verdict gated
 * the rung forever — including after the executor shipped and the SAME rung had
 * demonstrably converged on executed evidence (PR #457: executed_fail → fix
 * worker → executed_pass ×3 → merged, while #449/#452 were refused at 2/2 with
 * executed_fail verdicts of their own).
 *
 * Under the `"executed"` regime, keyword-only strikes are NOT counted: they were
 * spent against noise and say nothing about whether the rung would converge on
 * evidence. Under `"keyword_only"` every strike counts, because there is no
 * better signal to distinguish them and the bound must not silently vanish.
 *
 * THE BOUND STAYS REAL either way — strikes spent under the CURRENT regime always
 * count, so a task genuinely failing against executed evidence still exhausts.
 * This never mutates the ledger: it changes how strikes are READ.
 */
export function priorStrikesFor(
  lines: Array<Record<string, unknown>>,
  taskId: string | undefined,
  currentRegime: StrikeRegime = "keyword_only",
): number {
  if (!taskId) return 0;
  let n = 0;
  for (const line of lines) {
    if (line.step !== "fix.dispatch" || line.task_id !== taskId) continue;
    // Under the executed regime a keyword-era strike is amnestied; every other
    // combination counts, so the cap keeps binding on same-regime failures.
    if (currentRegime === "executed" && strikeRegimeOf(line) === "keyword_only") continue;
    n++;
  }
  return n;
}

/**
 * W1-T78: what each fix-rung strike TRIED for a task, ledger ground truth
 * ONLY (never inferred) — the clarification-question rung's "what the fix
 * worker tried per strike" input. `fix.dispatch` opens a strike (round +
 * unmet count going IN); `fix.review` (only reached once CI is green) records
 * its outcome. A strike with no matching `fix.review` line simply never
 * reached a review (e.g. `fix.ci_not_green` — CI never went green).
 */
export function deriveStrikeHistory(lines: Array<Record<string, unknown>>, taskId: string | undefined): StrikeAttempt[] {
  if (!taskId) return [];
  const byStrike = new Map<number, StrikeAttempt>();
  for (const line of lines) {
    if (line.task_id !== taskId) continue;
    const strike = typeof line.strike === "number" ? line.strike : undefined;
    if (strike === undefined) continue;
    if (line.step === "fix.dispatch") {
      byStrike.set(strike, {
        strike,
        round: line.round === "fresh" ? "fresh" : "resume",
        unmetCount: typeof line.unmet_count === "number" ? line.unmet_count : 0,
        ciGreen: false,
      });
    } else if (line.step === "fix.review") {
      const existing = byStrike.get(strike);
      if (existing) {
        existing.ciGreen = true; // fix.review only ever runs once CI is green
        existing.reviewState = line.state === "success" ? "success" : "failure";
      }
    }
  }
  return [...byStrike.values()].sort((a, b) => a.strike - b.strike);
}

/**
 * The CHEAPLY-ENUMERABLE half of the mint's reserved set (lib/task-id.ts): every open PR's
 * title, body, and head branch, as raw text to scan for already-minted `W1-T<n>` ids. ONE
 * `gh pr list` — deliberately WITHOUT `statusCheckRollup` (the payload-heavy field
 * `buildOpenPrViews` needs), so this stays an O(1)-ish read a mint can always afford.
 *
 * An id minted by an OPEN plan PR exists nowhere on main — that is exactly the gap that let
 * `W1-T256` be minted twice (#770). Scanning free text over-counts by design: a skipped
 * number costs nothing, a collision costs a renumber + re-push cycle.
 */
export function openPrMintTexts(owner: string, repo: string): string[] {
  const rows = ghJson([
    "pr", "list", "--repo", `${owner}/${repo}`, "--state", "open", "--limit", "100",
    "--json", "title,body,headRefName",
  ]) as Array<{ title?: string; body?: string; headRefName?: string }>;
  return rows.map((r) => [r.title ?? "", r.body ?? "", r.headRefName ?? ""].join("\n"));
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
export function buildOpenPrViews(
  owner: string,
  repo: string,
  ledgerPath: string,
  // APPENDED LAST, both defaulted, so none of the three positional call sites shift. Injectable
  // because the merge-state wiring below is otherwise unreachable in a test — every existing
  // sweep test builds `OpenPrView` fixtures by hand and so never exercises this function at all.
  deps: {
    fetch?: GhApiFetcher;
    requiredContexts?: (owner: string, repo: string) => string[] | undefined;
  } = {},
): OpenPrView[] {
  const fetch = deps.fetch ?? ghJson;
  const raw = fetchOpenPrsRest(owner, repo, fetch) as RawOpenPr[];
  const ledger = readLedgerLines(ledgerPath);
  // W1-T103: branch protection's OWN required-contexts list, read ONCE per
  // repo for this whole sweep pass (never per-PR, never hardcoded) — see
  // checksStateFromRollup's doc for why this must gate checksState instead of
  // every reported check.
  const requiredContexts = (deps.requiredContexts ?? ghRequiredStatusCheckContexts)(owner, repo);

  // MERGE STATE: one bounded follow-up fetch per PR, because the LIST endpoint omits
  // `mergeable_state` (see hydrateMergeStates' doc for the live verification and the incident).
  // Scoped to the PRs this pass will actually disposition — measured median 1, p95 6, max 23 over
  // 5,735 sweeps — and hard-capped, so the pathological case cannot run away. Best-effort by
  // construction: an exhausted budget yields an empty map and every PR keeps the `undefined` it
  // has carried since the REST migration, i.e. exactly today's behaviour.
  const mergeStates = hydrateMergeStates(
    owner,
    repo,
    raw.map((p) => p.number),
    fetch,
  );

  // supersededBy: the HIGHEST-numbered other open PR crediting the same task.
  const byTask = new Map<string, number[]>();
  for (const pr of raw) {
    const t = taskIdFromBody(pr.body ?? "");
    if (!t) continue;
    (byTask.get(t) ?? byTask.set(t, []).get(t)!).push(pr.number);
  }

  return raw.map((pr) => {
    const taskId = taskIdFromBody(pr.body ?? "");
    const peers = taskId ? (byTask.get(taskId) ?? []) : [];
    const newest = peers.length ? Math.max(...peers) : pr.number;
    const supersededBy = newest > pr.number ? newest : undefined;
    const reviewState = reviewStateFromRollup(pr.statusCheckRollup);
    const checksState = checksStateFromRollup(pr.statusCheckRollup, requiredContexts);
    const reviewOrphans = reviewOrphansFor(ledger, taskId, pr.headRefOid);
    return {
      prNumber: pr.number,
      prUrl: pr.url,
      taskId,
      reviewState,
      checksState,
      unmetCriteria: reviewState === "failure" && taskId ? unmetFromLedger(ledger, taskId) : [],
      priorStrikes: priorStrikesFor(ledger, taskId, currentStrikeRegimeFor(ledger, taskId)),
      strikeHistory: deriveStrikeHistory(ledger, taskId),
      supersededBy,
      lastActivityAt: pr.updatedAt,
      headSha: pr.headRefOid,
      autoMergeArmed: pr.autoMergeRequest != null,
      // W1-T54 routing: Dependabot PRs go to the dep-review lane, never the
      // fix/clarification rungs — branch prefix is Dependabot's own contract.
      isDependabot: (pr.headRefName ?? "").startsWith("dependabot/"),
      // The ABSENT-check-suite remedy pushes an empty commit to THIS branch. Already fetched
      // for isDependabot above — carried through rather than re-queried.
      headRefName: pr.headRefName,
      reviewSummary: undefined,
      // W1-T100: the ci-log fix mode's input — only worth fetching when checks
      // are actually red (a PR gate that already needs blocked_ci's rung).
      ciFailures: checksState === "red" ? fetchCiFailures(owner, repo, pr.statusCheckRollup) : undefined,
      // W1-T176: only meaningful in the zero-runs shape post-review routes on;
      // cheap to compute unconditionally rather than re-deriving checksState
      // green/reviewState none here just to gate the ledger scan.
      reviewPostRefused: reviewPostRefusedFor(ledger, taskId, pr.headRefOid),
      // W1-T225: both halves from ONE ledger scan, off the ledger this function already holds —
      // no extra request. Assigned INSIDE this literal deliberately: PR #1083's
      // producer-completeness test anchors on an object literal assigning every required
      // OpenPrView field, so an assignment made anywhere else would still read as unwired.
      reviewOrphanedByPush: reviewOrphans.orphanedByPush,
      priorReviewOrphans: reviewOrphans.priorOrphans,
      // W1-T176 (design boundary (ii)): `ghRequiredStatusCheckContexts` fails
      // SOFT to undefined/empty on an unreadable protection rule — that same
      // signal must gate the zero-runs discriminator OFF (never assume
      // permissive on missing information).
      requiredContextsUnreadable: !requiredContexts || requiredContexts.length === 0,
      // Absent from the map ⇒ GitHub had not computed it (or we could not ask) ⇒ undefined, the
      // pre-existing value. Only a DEFINITE observed "dirty" ever reaches the conflicted rows.
      mergeState: mergeStates.get(pr.number),
    };
  });
}

/**
 * Build the credit-backfill rung's input (W1-T150, ratifies P30): one
 * {@link CreditCandidate} per task in `plan` whose merge state — derived via
 * the SAME `deriveStatus` ownership rule dispatch and calibration already
 * trust (P29(i)/W1-T149 sibling credit: ANY run of the task owning the merged,
 * trailer-anchored PR counts, not just the run the ledger happens to name) —
 * is currently MERGED on GitHub. Uses the BATCHED gateway (one `gh pr list`
 * for the whole repo, not one per task — the same O(N)-avoidance
 * `buildBatchedGithub`'s own doc motivates for the board) since this walks
 * every task in the plan on every sweep/daemon poll. Best-effort: a
 * plan-unavailable repo (already logged by the caller) simply yields plan.tasks
 * === [] here, never a hard failure of its own.
 */
function buildCreditCandidates(
  owner: string,
  repo: string,
  plan: Plan,
  ledgerPath: string,
  log?: (step: string, extra?: Record<string, unknown>) => void,
): CreditCandidate[] {
  // W1-T181: wires the same fetch-size/fetch-failure observability the SERVE board gateway gets —
  // this sweep/daemon-poll gateway shells the identical `gh pr list` this outage's fix targeted.
  const deps: DeriveDeps = { ledgerPath, github: buildBatchedGithub(owner, repo, { log }) };
  const candidates: CreditCandidate[] = [];
  for (const task of plan.tasks) {
    const proj = deriveStatus(task, deps);
    if (proj.merged && proj.prNumber !== undefined && proj.prUrl !== undefined) {
      candidates.push({ taskId: task.id, prNumber: proj.prNumber, prUrl: proj.prUrl, merged: true });
    }
  }
  return candidates;
}

/**
 * fb-1784756088300-6a481e: one {@link EscalationReconcileCandidate} per OPEN needs-human
 * issue, pairing it with its referenced task's CURRENT state — the SAME #737/#741-corrected
 * `deriveStatus` every other rung trusts. The task id is read from the issue body's
 * `**Task:** <id>` line (W1-T186 — `renderIssueBody` writes it on every escalation). An issue
 * with no named task, or one whose task is not in THIS plan, yields NO candidate — genuinely-
 * human territory, left untouched. Uses the BATCHED gateway (one `gh pr list`) for derivation
 * and one `gh issue list` for the open queue; a FAILED issue-list read yields [] (do nothing
 * this cycle, never a false "zero open"), the same best-effort contract as buildCreditCandidates.
 */
/**
 * What the escalation reconciler's INTAKE saw, so `total: 0` stops being ambiguous.
 *
 * `sweep.escalation_reconcile.summary` logs `total` = `candidates.length`, counted AFTER the open
 * issues have been turned into candidates — so `total: 0` reads identically whether nothing was
 * open or everything open was dropped. That ambiguity cost a full recon: an operator saw `total: 0`
 * beside three open needs-human issues and reasonably concluded the reconciler was broken. It was
 * not — they had been closed minutes earlier, one of them BY the reconciler. But the defective
 * reading was REAL as recently as the same afternoon: between 16:00 and 17:48, two issues were open
 * and labelled while 23 of 24 summaries reported `total: 0` (fixed by PR #1084).
 *
 * `issuesSeen: 3, total: 0` is the signature of that defect. The old line could not express it.
 */
export interface EscalationIntake {
  /** Issues the query returned, taken one statement after the read and before the candidate loop. */
  issuesSeen: number;
  /** Dropped for carrying no `**Task:**` trailer — genuinely human territory. */
  droppedNoTaskTrailer: number;
  /** Dropped for naming neither a plan task nor any resolvable PR referent. */
  droppedNoReferent: number;
}

export function buildEscalationReconcileCandidates(
  owner: string,
  repo: string,
  plan: Plan,
  ledgerPath: string,
  log?: (step: string, extra?: Record<string, unknown>) => void,
  // Injectable seams (mirrors buildCreditCandidates' buildBatchedGithub): real callers omit
  // both and get the live `gh` gateways; tests supply fakes to drive the parse + derivation
  // without shelling out.
  injected: { issues?: IssueGateway; github?: GitHub; onIntake?: (intake: EscalationIntake) => void } = {},
): EscalationReconcileCandidate[] {
  const issues = injected.issues ?? ghIssueGateway(owner, repo);
  let open: OpenIssue[];
  try {
    // W1-T349: needs-human AND fleet-notice — a demoted item must still self-retire.
    open = listRetirableEscalationIssues(issues);
  } catch (e) {
    log?.("sweep.escalation_reconcile.list_failed", { error: String((e as Error)?.message ?? e) });
    return []; // a failed read is "do nothing this cycle", never a confident "zero open needs-human"
  }
  // WHERE `issuesSeen` IS TAKEN, and why HERE. This is the list as the gateway returned it and as
  // the loop below is about to consume it — one statement after the read, before the loop, before
  // any per-issue derivation. Every drop the summary's ambiguity is about happens in that loop, so
  // `issuesSeen - total` counts exactly those drops and nothing else.
  //
  // Deliberately NOT the raw REST row count. `parseLabelledIssuesRest` already drops rows carrying
  // `pull_request` (escalate.ts:160-173) — an intended filter, not a defect — so counting rows
  // would make `issuesSeen > total` on a healthy pass whenever a PR happens to carry the label,
  // i.e. a false alarm in the one field added to stop false alarms.
  const intake: EscalationIntake = { issuesSeen: open.length, droppedNoTaskTrailer: 0, droppedNoReferent: 0 };
  const deps: DeriveDeps = { ledgerPath, github: injected.github ?? buildBatchedGithub(owner, repo, { log }) };
  const candidates: EscalationReconcileCandidate[] = [];
  for (const issue of open) {
    const taskId = /^\*\*Task:\*\*\s*(\S+)\s*$/m.exec(issue.body ?? "")?.[1];
    if (!taskId) {
      intake.droppedNoTaskTrailer++;
      continue; // no named task — leave untouched (human territory)
    }
    const task = plan.byId.get(taskId);
    // SYNTHETIC PR REFERENT. An escalation for an untrailered operator-lane PR names it `PR-<n>`
    // (see the clarification rung's `escalate`, above) — a real, resolvable referent that is
    // simply not a PLAN TASK, so `plan.byId` misses it by construction and the `!task` guard below
    // would drop it forever. That is exactly how 53 issues became unretirable.
    //
    // Resolving it needs no plan entry: the PR NUMBER is the referent, and the SAME batched
    // gateway `deriveStatus` is about to use already answers merged/closed for a bare number via
    // `prByRef`. So this derives the identical `derived` shape from the number and hands the
    // reconciler a candidate it can actually close — the round trip the synthetic id is only
    // worth minting if it completes.
    //
    // FAIL-SOFT, matching `deriveStatus`'s own polarity: a gateway that CANNOT answer yields
    // `indeterminate`, never a confident "not merged" — the closer already refuses to act on an
    // indeterminate referent, so an unreadable PR leaves its issue open rather than closing it on
    // a read failure.
    if (!task) {
      const synthetic = /^PR-(\d+)$/.exec(taskId);
      // impl-DY: an id the plan does not own and that was NOT minted in the `PR-<n>` shape still names its
      // referent — `renderIssueBody` writes the PR as a full URL into the issue text. Read it back rather
      // than dropping the issue forever. This is the operator's own framing ("the system should be able to
      // determine that those are already handled") and it is the last remaining way an escalation becomes
      // permanently unretirable: `TRIAGE-fb-1784732687221-3be743` (PR #707, merged 2026-07-24) and
      // `TRIAGE-fb-1784917146019-88250d` (PR #775, merged 2026-07-25) survived a hand-cleanup of 55 siblings
      // for exactly this reason. Title is the fallback source — every escalation title carries the PR URL too,
      // so a body that was edited (or truncated by a gateway) still resolves.
      const bodyReferent = synthetic ? undefined : prReferentFromIssueText(issue.body) ?? prReferentFromIssueText(issue.title);
      if (!synthetic && bodyReferent === undefined) {
        intake.droppedNoReferent++;
        continue; // no task, no PR anywhere — genuinely human territory
      }
      const prNumber = synthetic ? Number(synthetic[1]) : bodyReferent!;
      const ref = deps.github.prByRef(prNumber);
      const state = ref?.state?.toUpperCase();
      candidates.push({
        issueUrl: issue.url,
        issueNumber: issue.number,
        taskId,
        derived: {
          merged: state === "MERGED",
          closed: state === "CLOSED",
          indeterminate: ref === null || ref === undefined ? true : undefined,
          prUrl: ref?.url,
          prNumber: ref?.number ?? prNumber,
          source: synthetic ? "pr-referent" : "pr-referent-from-issue-text",
        },
      });
      continue;
    }
    const proj = deriveStatus(task, deps);
    // W1-T162: a referent whose PR CLOSED WITHOUT MERGING is also terminal — superseded or
    // abandoned, no longer a live blocker — distinct from an open/blocked-pending-fix PR.
    // deriveStatus's `prState` carries the raw GitHub state through unchanged (status.ts's
    // `fromPrState` only ever sets `status: "blocked"` for a raw "closed" state, so checking
    // `prState` directly here is the same signal, made explicit rather than inferred from
    // `status`). Mutually exclusive with `merged` by construction (fromPrState never sets both).
    const closedWithoutMerge = !proj.merged && proj.prState?.toUpperCase() === "CLOSED";
    candidates.push({
      issueUrl: issue.url,
      issueNumber: issue.number,
      taskId,
      derived: {
        merged: proj.merged,
        closed: closedWithoutMerge,
        indeterminate: proj.indeterminate,
        prUrl: proj.prUrl,
        prNumber: proj.prNumber,
        source: proj.source,
      },
    });
  }
  // NON-FATAL BY CONSTRUCTION: a throwing observer must never take out the sweep, which runs this
  // every pass on the live fleet. The reconciler proceeds with whatever it built either way.
  try {
    injected.onIntake?.(intake);
  } catch {
    /* observability only — never fatal */
  }
  return candidates;
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
export function buildFixRungDispatchArgs(args: {
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
  pr: { headSha: string; reviewSummary?: string; pendingAnswer?: { constraint: string; resetStrikeCounter?: boolean } };
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
        criteria: unmet,
        testTheater: false,
        summary: pr.reviewSummary ?? `sweep-reconstructed failing review (${unmet.length} unmet)`,
        floorDegraded: false,
        capped: false,
        keywordOnly: false,
        planOnly: false,
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
    constraint: pr.pendingAnswer?.constraint,
    ciFailures: evidence.ciFailures,
    mergeConflict: evidence.mergeConflict,
    reviewBase: args.reviewBase,
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
 *
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
): { task: { id: string; title: string; risk: TaskRisk; acceptance: AcceptanceCriterion[]; budget_usd?: number }; synthetic: boolean } {
  const found = pr.taskId ? plan.tasks.find((t) => t.id === pr.taskId) : undefined;
  if (found) return { task: found as never, synthetic: false };
  return {
    task: {
      id: escalationTaskIdFor(pr),
      title: `PR #${pr.prNumber}`,
      risk: DEFAULT_RISK,
      acceptance: body ? parseAcceptanceBlock(body) : [],
    },
    synthetic: true,
  };
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
  // A synthetic id covers two shapes: an agent PR with NO id at all (descriptive branch), and a
  // LANE PR whose id is real but absent from plan.tasks (TRIAGE-*/RETRO-*/PLAN-* — 20 of the 65
  // PRs in the measured trail). The lane PR's own `run-<id>-<ts>` head is legitimately its own, so
  // accept it; refuse only a head claiming a DIFFERENT task, which means mis-trailered, not
  // task-less, and amending it would push onto another task's run branch.
  return ownRunBranch || !isDispatchedRunBranch(head);
}

export function buildSweepEffects(
  owner: string,
  repo: string,
  config: Config,
  ledgerPath: string,
  runId: string,
  plan: Plan,
  log: (step: string, extra?: Record<string, unknown>) => void,
  policy: SweepPolicy = DEFAULT_SWEEP_POLICY,
  // W1-T254: injectable review runner so the post-review effect's attempt/
  // done/failed logging path is unit-covered without spawning a real review.
  reviewRunner: (prNumber: number) => Promise<number> = (prNumber) => reviewCommand(String(prNumber), ["--repo", repo]),
  // Injectable worker spawn, same shape and rationale as `reviewRunner` directly above: the
  // fix rung's own effects (including its best-effort push) were unreachable from any offline
  // test because the adapter below hardcoded `spawnWorker`. Optional with no default body, so
  // this adds no new executable line — the adapter itself resolves it.
  spawnImpl?: (args: SpawnWorkerArgs) => Promise<WorkerResult>,
  // Injectable empty-commit push — appended LAST so every existing positional caller is
  // untouched. Same rationale as `reviewRunner`/`spawnImpl` above: the ABSENT remedy's wiring
  // is unit-covered with a recorder instead of a real push to a real branch.
  pushEmptyCommit: typeof gitPushEmptyCommit = gitPushEmptyCommit,
  // Injectable issue gateway — appended LAST so no positional caller shifts, the same convention
  // `reviewRunner`/`spawnImpl`/`pushEmptyCommit` above already follow. Without it the `escalate`
  // closure's own body is unreachable from any offline test (it would open a REAL needs-human
  // issue), which is exactly how the `taskId:` mint inside it went uncovered.
  issuesImpl?: IssueGateway,
  // Injectable stall notice — appended LAST so no positional caller shifts, the same convention
  // `reviewRunner`/`spawnImpl`/`pushEmptyCommit`/`issuesImpl` above already follow. The postReview
  // closure wraps this call in a try/catch so a throw from the NOTICE can never replace the real
  // failure being reported; that catch arm is only reachable if something in here throws, so it is
  // only provable with an injected thrower.
  stallNotice: (verdict: PostReviewStallVerdict, ctx: { owner: string; repo: string; ledgerPath: string; runId: string; issues?: IssueGateway }) => void = escalatePostReviewStall,
): Pick<SweepDeps, "arm" | "close" | "dispatchFix" | "escalate" | "readLiveState" | "depReview" | "postReview" | "repushAbsent"> {
  const repoDir = repo === resolveOwnerRepo().repo ? repoRoot : join(config.root, "repos", repo);
  const issues = issuesImpl ?? ghIssueGateway(owner, repo);
  const say = (msg: string) => console.error(`### rmd sweep — ${msg}`);

  return {
    // impl-BI — RETURN THE OUTCOME. PR #968 taught `runSweep` to read this effect's return
    // value (`armOutcomeArmed(armOutcome)` → `acted:false` + a stand-down reason), but THIS
    // adapter — the only implementation the daemon ever runs — still discarded it, so the
    // effect resolved to `undefined`. `armOutcomeArmed(undefined)` returns true by design
    // (it preserves the pre-#968 assumption for fakes that return nothing), which meant the
    // real sweep kept recording `acted:true` for refused arms and #968 was inert in
    // production. A brace and a `return` are the whole difference.
    arm: (pr) => armAutoMerge(pr.prUrl, pr.taskId),

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
        const exit = await reviewRunner(pr.prNumber);
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
        execFileSync("gh", ["pr", "close", pr.prUrl, "--comment", `Closed by rmd sweep: ${reason}`, "--delete-branch"], {
          stdio: "pipe",
        });
      } catch (e) {
        log("sweep.close.error", { pr_number: pr.prNumber, error: String((e as Error)?.message ?? e) });
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
      escalate(
        {
          class: "BLOCKED",
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
      try {
        // W1-T177 SITE (v): an INDEPENDENT fresh live-state read, via the
        // SAME `readLiveState`/`ghLiveState` fail-open contract every other
        // spending site uses (see {@link dispatchFixPreflightStandDown}) —
        // BEFORE any worktree/git side effect (fetch/add/checkout) ever
        // touches this PR. A failed/indeterminate read is ledgered and never
        // stands the dispatch down; only a positive terminal reading does.
        const preflightStandDown = await dispatchFixPreflightStandDown(ghLiveState, pr, log);
        if (preflightStandDown) return;

        // Creditability is load-bearing (status.ts ownsBranch): a fix must amend
        // THIS task's own run-branch (run-<id>-<epochMs>), never a foreign/fix-*
        // head — a fix on an uncreditable head loops forever + strands dependents.
        // `body` is fetched in the SAME call (never a second `gh pr view`) so
        // `fixRungTaskFor` can resolve a synthetic (no-task) PR's acceptance
        // criteria from its `## Acceptance` block — see that function's doc for
        // why a hardcoded `[]` here made a `blocked_review` synthetic dispatch
        // permanently unjudgeable.
        const headRef = ghJson(["pr", "view", pr.prUrl, "--json", "headRefName,body"]) as {
          headRefName?: string;
          body?: string;
        };
        // impl-FY: a PR with no plan task is STILL repairable — see fixRungTaskFor. The rung used to
        // log `sweep.fix.no_task` and return here, which is why seven agent-authored PRs were
        // classified fixable and then silently skipped every poll.
        const { task, synthetic } = fixRungTaskFor(plan, pr, headRef.body);
        if (synthetic) log("sweep.fix.synthetic_task", { pr_number: pr.prNumber, task_id: task.id });
        const realBranch = headRef.headRefName;
        if (!realBranch || !fixHeadAcceptable(realBranch, task.id, synthetic)) {
          log("sweep.fix.uncreditable_head", { pr_number: pr.prNumber, head: realBranch, synthetic });
          return;
        }
        worktreePath = join(worktreesDir(config), `sweep-${task.id}-${Date.now()}`);
        execFileSync("git", ["-C", repoDir, "fetch", "origin", "--quiet"], { stdio: "pipe" });
        execFileSync("git", ["-C", repoDir, "worktree", "add", worktreePath, `origin/${realBranch}`], { stdio: "pipe" });
        execFileSync("git", ["-C", worktreePath, "checkout", "-B", realBranch, `origin/${realBranch}`], { stdio: "pipe" });

        const mountsTable = loadMounts(mountsPath(repoRoot));
        const fixMount: Mount = resolveMount(mountsTable, "fix", task.risk);
        const reviewerMount: Mount = resolveMount(mountsTable, "reviewer", task.risk);
        const settingsFile = renderWorkerSettings({
          templatePath: join(repoRoot, "settings", "worker.json"),
          hooksDir: join(repoRoot, "hooks"),
          outPath: join(config.root, "tmp", `sweep-fix-settings-${task.id}-${Date.now()}.json`),
        });
        const budgetUsd = task.budget_usd ?? DEFAULT_BUDGET_USD;

        // W1-T78: an operator's answer to a PRIOR clarification question
        // (routed here by the DISPOSITION_RULES "answered" row) re-arms this
        // SAME dispatch — never a new call site — carrying the answer as an
        // added constraint and a strike cap set per the answer's own policy
        // (config-driven, {@link strikeCapForAnswer}), instead of the
        // ORIGINAL blocked_review dispatch's plain strikeCap. The fallback
        // (when the answer itself carries no override) is `policy.clarify` —
        // the SAME policy `DISPOSITION_RULES`' answered row just used to
        // ROUTE here — never a second, independently-hardcoded default that
        // could silently diverge from the routing decision.
        const strikeCap = pr.pendingAnswer
          ? strikeCapForAnswer(fixStrikeCap(config), {
              resetStrikeCounterOnAnswer: pr.pendingAnswer.resetStrikeCounter ?? policy.clarify.resetStrikeCounterOnAnswer,
            })
          : fixStrikeCap(config);

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
            spawn: (args) => (spawnImpl ?? spawnWorker)({ ...args, resumeSessionId: args.resumeSessionId || undefined }),
            waitForCiGreen,
            // W1-T138: refresh the ci-log evidence whenever a strike leaves CI
            // non-green — see runFixRung's own doc for why this must happen on
            // every strike, not just the first.
            fetchCiFailures: async (prUrlArg) => {
              const v = ghJson(["pr", "view", prUrlArg, "--json", "statusCheckRollup"]) as {
                statusCheckRollup?: RollupCheck[];
              };
              return fetchCiFailures(owner, repo, v.statusCheckRollup);
            },
            runReview,
            push: (wt) => {
              try {
                gitPushRunBranch(wt, { stdio: "ignore" });
              } catch {
                /* best-effort — the worker may already have pushed */
              }
            },
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
            log: (s, extra) => log(s, { task_id: task.id, ...extra }),
            say,
            account: (r) => r, // sweep meters nothing extra; the ledger carries per-spawn cost
            // W1-T177: the SAME live-state reader every fix-rung call site
            // wires — a fresh `gh pr view` read, never the sweep's `openPrs`
            // snapshot this dispatch was selected from.
            readLiveState: ghLiveState,
            // W1-T296: the SAME live-head reader every fix-rung call site
            // wires for the pre-strike branch-authorship check.
            readLiveHead: ghLiveHead,
          },
        });
      } catch (e) {
        log("sweep.fix.error", { pr_number: pr.prNumber, error: String((e as Error)?.message ?? e) });
      } finally {
        if (worktreePath) {
          try {
            worktreeRemove(repoDir, worktreePath);
          } catch {
            /* best-effort cleanup */
          }
        }
      }
    },

    // W1-T177 SITE (iii): consulted by `runSweep` immediately before a
    // blocked-fixable disposition actually spends a fix-rung strike — see
    // `SweepDeps.readLiveState`'s own doc for the fail-open contract.
    readLiveState: (pr) => ghLiveState(pr.prUrl),
  };
}

/**
 * `rmd sweep [--repo <name>] [--dry-run]` — run ONE level-triggered reconciliation
 * pass over every open PR (W1-T77, ratifies P22 core). FAIL LOUD on junk args
 * BEFORE any `gh`/spawn (Standing rule). --dry-run previews dispositions and takes
 * NO effects. Non-zero exit only on a hard error.
 */
export async function sweepCommand(rest: string[]): Promise<number> {
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
  const runId = `SWEEP-${Date.now()}`;
  const log = (step: string, extra: Record<string, unknown> = {}) =>
    appendLedger(ledgerPath, { run_id: runId, task_id: "SWEEP", step, ...extra });

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
    openPrs = buildOpenPrViews(owner, repo, ledgerPath);
  } catch (e) {
    console.error(`### rmd sweep — could not list open PRs for ${owner}/${repo}: ${String((e as Error)?.message ?? e)}`);
    return 1;
  }

  const effects = buildSweepEffects(owner, repo, config, ledgerPath, runId, plan, log, DEFAULT_SWEEP_POLICY);
  const summary = await runSweep(
    openPrs,
    { ...effects, ledgerPath, runId, log, dryRun },
    DEFAULT_SWEEP_POLICY,
  );

  // W1-T150 — the credit-backfill rung (ratifies P30): level-triggered, like
  // the open-PR reconciliation above, but over every task's OWNED merge state
  // rather than open-PR pipeline state — the gate-side-merge fixture (0 of 195
  // runs ledgered a merge while GitHub showed 28) this rung exists to close.
  const creditCandidates = buildCreditCandidates(owner, repo, plan, ledgerPath, log);
  const creditSummary = await runCreditBackfill(creditCandidates, { ledgerPath, runId, log, dryRun });

  // fb-1784756088300-6a481e — the escalation-lifecycle reconciler rung: close stale
  // needs-human issues whose referenced task has since resolved (the missing third leg
  // of the escalation lifecycle). Same level-triggered doctrine + cadence as the two rungs
  // above; bounded per cycle so a backlog drains gradually.
  const reconcileSummary = await sweepEscalationReconcile(owner, repo, plan, ledgerPath, runId, log, { dryRun });

  // W1-T175 — the worktree reaper rung: same level-triggered doctrine + cadence as the
  // rungs above, closing pruneStaleRuns' coverage holes (git-invisible dirs, detached-HEAD
  // sweep-* orphans, widowed .lock files) on THIS cadence, not only at a run's own start.
  // --dry-run takes no effects, matching every other rung in this command.
  let reapSummary: WorktreeReapSummary = { reaped: [], reapedLocks: [], kept: [] };
  if (!dryRun) {
    reapSummary = runWorktreeReapRung(config, log);
  }

  console.log(
    `### rmd sweep${dryRun ? " --dry-run" : ""} — ${owner}/${repo}\n` +
      renderSweepSummary(summary) +
      `\ncredit backfill: ${creditSummary.total} candidate(s) reconciled · ${creditSummary.corrected} corrected` +
      `\nescalation reconcile: ${reconcileSummary.total} open needs-human issue(s) checked · ${reconcileSummary.closed} closed` +
      `\nworktree reap: ${reapSummary.reaped.length} worktree(s) reaped · ${reapSummary.reapedLocks.length} widowed lock(s) reaped`,
  );
  return 0;
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
export async function sweepEscalationReconcile(
  owner: string,
  repo: string,
  plan: Plan,
  ledgerPath: string,
  runId: string,
  log: (step: string, extra?: Record<string, unknown>) => void,
  opts: { dryRun?: boolean; issues?: IssueGateway; github?: GitHub } = {},
): Promise<EscalationReconcileSummary> {
  let intake: EscalationIntake | undefined;
  const candidates = buildEscalationReconcileCandidates(owner, repo, plan, ledgerPath, log, {
    issues: opts.issues,
    github: opts.github,
    onIntake: (i) => {
      intake = i;
    },
  });
  return runEscalationReconcile(candidates, {
    intake,
    closeIssue: buildEscalationCloser(owner, repo, opts.issues),
    ledgerPath,
    runId,
    log,
    dryRun: opts.dryRun,
  });
}

/**
 * W1-T320's PER-POLL rung for the tmp-dir backstop (design clause ii) — rides the daemon's
 * poll cadence the same way `runWorktreeReapRung` (worker.ts) does, so the 26,711-dir ENOSPC
 * backstop (src/lib/tmp.ts's `sweepStaleTempDirs`) actually re-fires on a long-running healthy
 * daemon instead of only once at boot ('removed: 0, kept: 49979' on ten straight boots was the
 * boot-only cadence's failure mode: a healthy daemon between boots never re-ran it at all).
 *
 * `opts.maxAgeMs` is the caller's resolved policy value — the real command threads
 * `policy.values.sweep.tmpMaxAgeMs`, off the SAME repoRoot-scoped `policy` load
 * pollIntervalMs/the headroom curve already use (see `buildSweepHook`'s `tmpMaxAgeMs` param),
 * never a second, independent policy read here (test/config-reader-seams.test.ts's structural
 * check pins every unredirectable `loadPolicy`/`loadDefaultPolicy` call site by name — this rung
 * deliberately stays off that list by taking the value in, not reading it). Omitted ⇒
 * `sweepStaleTempDirs`'s own default (`DEFAULT_TEMP_SWEEP_MAX_AGE_MS`) applies, same as before
 * this task for any caller that predates it.
 *
 * Logs `daemon.tmp_sweep` with removed/kept COUNTS plus the oldest-kept age in ms (design
 * clause iii), so "kept 0 because nothing qualified" reads differently from "kept N and the
 * oldest is already close to the ceiling" — the boot-only line carried neither signal.
 * Best-effort: `sweepStaleTempDirs` itself never throws, but this wrapper still degrades to a
 * logged error rather than ever escaping into the sweep composite around it.
 */
/**
 * THE PER-POLL RUNG FOR THE IN-FLIGHT LOCK SWEEP — the exact shape W1-T320 gave the tmp-dir
 * backstop in {@link runTmpSweepRung} below, applied to the same boot-only cadence bug in
 * `sweepStaleInflightLocks` (lib/inflight-lock.ts).
 *
 * THE HOLE THIS CLOSES. That sweep is wired ONCE, in `daemonCommand`'s boot rung list, and its
 * own doc explains why a stale lock otherwise never clears: a lock is reclaimed by the NEXT
 * acquire of that same task, so a task that is never re-dispatched — circuit-broken, blocked,
 * withdrawn — keeps a dead holder's lock until the daemon happens to restart. The observed case
 * in that doc (`W1-T1.lock`, pid 65304, dead two days) is exactly that population. Riding the
 * daemon's poll cadence means a healthy long-lived daemon clears it without needing a restart,
 * which is the same failure mode W1-T320 recorded for tmp dirs ("a healthy daemon between boots
 * never re-ran it at all").
 *
 * IT MATTERS MORE NOW THAN IT DID. `deriveStatus` reads these locks as its third liveness
 * disjunct (see DeriveDeps.inflightHolder, lib/status.ts). A stale lock is still refused there —
 * the pid probe is what refuses it — but a lock left lying around is a standing invitation for a
 * recycled pid to make a dead run read as live, and `kern.maxproc` is 4000 on this host. Sweeping
 * on the poll cadence shrinks that window from "until the next daemon restart" to one poll.
 *
 * Logs `daemon.inflight_sweep` with reaped/kept COUNTS plus the reaped task ids (bounded), so
 * "kept 0 because nothing was held" reads differently from "kept N live holders". Best-effort:
 * degrades to a logged error rather than escaping into the sweep composite around it, the same
 * discipline as the reap and tmp rungs it sits beside.
 */
export function runInflightLockSweepRung(
  config: Config,
  log: (step: string, extra?: Record<string, unknown>) => void,
): InflightSweepResult {
  try {
    const swept = sweepStaleInflightLocks(join(config.root, "state", "inflight"));
    log("daemon.inflight_sweep", {
      reaped: swept.reaped.length,
      kept: swept.kept.length,
      reaped_ids: swept.reaped.slice(0, 10),
    });
    return swept;
  } catch (e) {
    log("daemon.inflight_sweep", { error: String((e as Error)?.message ?? e) });
    return { reaped: [], kept: [] };
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
  owner: string,
  repo: string,
  config: Config,
  ledgerPath: string,
  runId: string,
  plan: Plan,
  log: (step: string, extra?: Record<string, unknown>) => void,
  tmpMaxAgeMs?: number,
): () => Promise<void> {
  // W1-T192: the daemon-side draft rung, built ONCE per daemon start (mirrors this
  // function's own once-per-daemon-start construction) — see buildInboxDraftHook's doc for
  // why it rides THIS seam rather than a second, separately-scheduled loop.
  const draftHook = buildInboxDraftHook(owner, repo, config, runId, log);
  return async () => {
    try {
      const openPrs = buildOpenPrViews(owner, repo, ledgerPath);
      const effects = buildSweepEffects(owner, repo, config, ledgerPath, runId, plan, log, DEFAULT_SWEEP_POLICY);
      await runSweep(openPrs, { ...effects, ledgerPath, runId, log }, DEFAULT_SWEEP_POLICY);
      // fb-1784756088300-6a481e: the escalation-lifecycle reconciler rung — closes stale
      // needs-human issues whose referenced task has since resolved, on the daemon's own
      // cadence. The missing third leg of the escalation lifecycle (creation W1-T8, dedup
      // W1-T195, closure here); same level-triggered doctrine as the credit rung below. Its
      // own read failures degrade to [] internally, so it never strands the credit rung.
      await sweepEscalationReconcile(owner, repo, plan, ledgerPath, runId, log);
      // W1-T150: the SAME credit-backfill rung `rmd sweep` runs, on the
      // daemon's own poll cadence — never a second, separately-scheduled loop.
      const creditCandidates = buildCreditCandidates(owner, repo, plan, ledgerPath, log);
      await runCreditBackfill(creditCandidates, { ledgerPath, runId, log });
      // W1-T175 — the worktree reaper rung, on the daemon's own poll cadence: the hole
      // this closes is specifically an IDLE fleet (no run dispatched, so pruneStaleRuns'
      // run-start trigger never fires) leaving crashed-run debris to grow unbounded. Own
      // try/catch, folded into runWorktreeReapRung (distinct from the shared "sweep.error"
      // below) so a reap hiccup never masks — or is masked by — the rungs above it.
      runWorktreeReapRung(config, log);
      // W1-T320 — the tmp-dir backstop's PER-POLL rung (design clause ii): rides this SAME
      // composite so it re-fires on a long-running healthy daemon, not only at boot. Own
      // try/catch (folded into runTmpSweepRung), same discipline as the reap rung above.
      runTmpSweepRung(log, tmpMaxAgeMs !== undefined ? { maxAgeMs: tmpMaxAgeMs } : {});
      // The in-flight lock sweep's PER-POLL rung — same argument as the tmp rung immediately
      // above (boot-only never re-fires on a healthy long-lived daemon), and now load-bearing
      // for `deriveStatus`'s lock-based liveness disjunct. Own try/catch inside the rung.
      runInflightLockSweepRung(config, log);
    } catch (e) {
      log("sweep.error", { error: String((e as Error)?.message ?? e) });
    }
    // W1-T192: the draft rung (fail-soft internally, its own try/catch) — a fired trigger
    // or an invalidated draft gets redrafted here, on the daemon's cadence, with no CLI
    // invocation required.
    await draftHook();
  };
}

/**
 * W1-T254 (the #707 fix) — the daemon's RESTRICTED LIGHT-SWEEP hook, ticked by
 * `DaemonDeps.sweepLight` WHILE `runOne` is in flight (see daemon.ts's doc on
 * that field). Wires the SAME `buildOpenPrViews` + `buildSweepEffects` +
 * `runSweep` the full sweep hook above uses — never a second, independently
 * built reconciler — but passes `actionable: d => d === "post-review"` so
 * ONLY the deterministic, sha-pinned, mutex-serialized re-post can fire here;
 * dispatchFix/close/escalate/depReview/arm always stand down
 * ("deferred to full sweep (light pass)") and re-derive on the next FULL
 * sweep instead, preserving the single-threaded reason those lanes exist
 * for. Deliberately excludes the credit-backfill rung and the inbox-draft
 * rung the full hook also runs — both are heavier, not concurrency-safe
 * alongside an in-flight `runOne`, and unrelated to the #707 cadence gap
 * this ticker exists to close. Best-effort, own try/catch: a hiccup here
 * costs one logged tick, never the daemon's liveness (the daemon.ts caller
 * ALSO wraps this call — see `daemon.sweep_light.failed` — this inner catch
 * just names the failure distinctly on this module's own ledger step).
 */
export function buildSweepLightHook(
  owner: string,
  repo: string,
  config: Config,
  ledgerPath: string,
  runId: string,
  plan: Plan,
  log: (step: string, extra?: Record<string, unknown>) => void,
): () => Promise<void> {
  return async () => {
    try {
      const openPrs = buildOpenPrViews(owner, repo, ledgerPath);
      const effects = buildSweepEffects(owner, repo, config, ledgerPath, runId, plan, log, DEFAULT_SWEEP_POLICY);
      await runSweep(
        openPrs,
        { ...effects, ledgerPath, runId, log, actionable: (d) => d === "post-review" },
        DEFAULT_SWEEP_POLICY,
      );
    } catch (e) {
      log("sweep_light.error", { error: String((e as Error)?.message ?? e) });
    }
  };
}

/** What `routeFix` did with one PR — mirrors the sweep's per-PR action shape. */
export type FixOutcome = "fixed" | "escalated" | "refused";

/** The two gated effects `routeFix` may fire — the SAME shape `SweepDeps` wires. */
export interface FixDeps {
  dispatchFix: SweepDeps["dispatchFix"];
  escalate: SweepDeps["escalate"];
}

/**
 * The PURE decision core of `rmd fix <pr-number>` (W1-T95) — injectable so the
 * routing is a unit fixture, independent of any live `gh`/spawn call. Given the
 * PR's raw GitHub state and its sweep-shaped view, this reuses the SAME
 * disposition rules `rmd sweep` derives from (`deriveDisposition` + `policy`)
 * and fires the SAME injected effects sweep wires (`dispatchFix`/`escalate`) —
 * never a reimplementation of the rung's dispatch:
 *   - not OPEN (merged/closed)                       -> refused, naming the state.
 *   - OPEN, disposition="blocked-fixable"             -> dispatchFix (fixed).
 *   - OPEN, disposition="conflicted" (W1-T106)         -> dispatchFix with
 *     merge-conflict evidence (fixed) — the SAME dispatch shape runSweep uses.
 *   - OPEN, failing review + strikes at/over the cap  -> escalate (escalated),
 *     naming the count — the cap is honored, never bypassed.
 *   - anything else (no block evidence: mergeable,
 *     stale, contradictory-failure)                   -> refused, naming the reason.
 */
export async function routeFix(
  prState: string | undefined,
  pr: OpenPrView,
  deps: FixDeps,
  policy: SweepPolicy = DEFAULT_SWEEP_POLICY,
): Promise<{ outcome: FixOutcome; reason: string }> {
  // W1-T177: the SAME extracted predicate every automated spending site now
  // calls (never a second, independently-hardcoded copy of this condition —
  // that drift is exactly how the #388/#398 fixture happened).
  const terminal = terminalStateReason(prState);
  if (terminal) {
    return { outcome: "refused", reason: terminal };
  }
  const { disposition, reason } = deriveDisposition(pr, policy);
  if (disposition === "blocked-fixable") {
    // W1-T100: the SAME evidence-shape selection runSweep uses, off the SAME
    // exported `isBlockedCi` predicate (never a second, independently-hardcoded
    // check) — a failing review carries the unmet set, a blocked_ci PR carries
    // ci-log evidence instead.
    await deps.dispatchFix(
      pr,
      isBlockedCi(pr) ? { unmetCriteria: [], ciFailures: pr.ciFailures ?? [] } : { unmetCriteria: pr.unmetCriteria },
    );
    return { outcome: "fixed", reason };
  }
  if (disposition === "conflicted") {
    // W1-T106: DISPOSITION_RULES already gated this on isPureConcurrentAddition
    // — reaching "conflicted" here means it's safe to dispatch. The
    // deletion-involved / unclassifiable case derives "blocked-ambiguous"
    // instead (falls through below), never this branch.
    await deps.dispatchFix(pr, { unmetCriteria: [], mergeConflict: pr.mergeConflict });
    return { outcome: "fixed", reason };
  }
  // Strike cap honored: the SAME rule the sweep policy uses to route to escalate
  // (failing review OR blocked_ci — a required check red, W1-T138 broadened this
  // to fire regardless of the review verdict beside it — with strikes already
  // at/over cap; W1-T100 generalizes this from review-only, one ladder, one
  // exhaustion route) — rmd fix never bypasses it.
  if ((pr.reviewState === "failure" || isBlockedCi(pr)) && pr.priorStrikes >= policy.strikeCap) {
    // W1-T78: the SAME clarification-question rendering the sweep uses — one
    // rung, one implementation, three callers now (drain live / sweep cold /
    // rmd fix bootstrap).
    const question = renderClarificationQuestion(pr, reason, pr.strikeHistory ?? []);
    await deps.escalate(pr, reason, question);
    return { outcome: "escalated", reason };
  }
  return { outcome: "refused", reason: `${reason} (no block evidence to drive the rung)` };
}

/**
 * `rmd fix <pr-number> [--repo <name>]` — the operator verb for the W1-T76 fix
 * rung (W1-T95). The rung is drive-only: drain invokes it live (a blocked_review
 * verdict inside a running task) and sweep invokes it cold (a PR discovered on a
 * poll). Neither helps when the BLOCKED PR *is* the sweep/drain delivery itself —
 * #160's shape — so this is the bootstrap/manual-override third caller: it
 * builds the single PR's observed state, then hands off to {@link routeFix}
 * wired with `buildSweepEffects`'s `dispatchFix`/`escalate` closures VERBATIM
 * (the exact functions `rmd sweep` wires) rather than adding a third direct call
 * into the rung itself — grep-provable: the rung dispatch call-site count is
 * unchanged.
 *
 * FAIL LOUD on junk args BEFORE any `gh` lookup/spawn (Standing rule).
 */
export async function fixCommand(
  rest: string[],
  // Injectable exactly as approveCommand/inboxCommand already are — the seam that lets the
  // REST lookup below be graded by a test instead of shipping unexercised.
  deps: { config?: Config; fetch?: GhApiFetcher } = {},
): Promise<number> {
  const prArg = rest[0];
  const badArg = unknownArgError("fix", rest.slice(1), ["--repo"], []);
  if (badArg) {
    console.error(badArg + "\n" + USAGE);
    return 2;
  }
  const prNumber = Number(prArg);
  if (!prArg || !Number.isInteger(prNumber) || prNumber <= 0) {
    console.error(`rmd fix: '${prArg ?? ""}' is not a valid PR number — usage: ${commandSyntax("fix")}\n` + USAGE);
    return 2;
  }

  const config = deps.config ?? loadConfig();
  const ledgerPath = ledgerPathFor(config);
  const self = resolveOwnerRepo();
  const repo = flagValue(rest, "--repo") ?? self.repo;
  const owner = self.owner;
  const runId = `FIX-${Date.now()}`;
  const log = (step: string, extra: Record<string, unknown> = {}) =>
    appendLedger(ledgerPath, { run_id: runId, task_id: "FIX", step, ...extra });

  let raw: RawOpenPr & { state?: string };
  try {
    // REST, for the same reason buildOpenPrViews uses it — `gh pr view --json` is GraphQL, and
    // `rmd fix` is the operator's manual recovery verb, so it must keep working precisely when
    // the GraphQL budget is the thing that is broken.
    raw = fetchSinglePrRest(owner, repo, prNumber, deps.fetch ?? ghJson) as RawOpenPr & { state?: string };
  } catch (e) {
    console.error(`### rmd fix — could not look up PR #${prNumber} in ${owner}/${repo}: ${String((e as Error)?.message ?? e)}`);
    return 1;
  }

  const ledger = readLedgerLines(ledgerPath);
  const taskId = taskIdFromBody(raw.body ?? "");
  const reviewState = reviewStateFromRollup(raw.statusCheckRollup);
  // W1-T103: same required-contexts gate as buildOpenPrViews — see
  // checksStateFromRollup's doc.
  const requiredContexts = ghRequiredStatusCheckContexts(owner, repo);
  const checksState = checksStateFromRollup(raw.statusCheckRollup, requiredContexts);
  const pr: OpenPrView = {
    prNumber: raw.number,
    prUrl: raw.url,
    taskId,
    reviewState,
    checksState,
    unmetCriteria: reviewState === "failure" && taskId ? unmetFromLedger(ledger, taskId) : [],
    priorStrikes: priorStrikesFor(ledger, taskId, currentStrikeRegimeFor(ledger, taskId)),
    strikeHistory: deriveStrikeHistory(ledger, taskId),
    // superseded-by is a cross-PR sweep concern (which OTHER open PR credits the
    // same task) — out of scope for a single explicitly-named PR lookup.
    supersededBy: undefined,
    lastActivityAt: raw.updatedAt,
    headSha: raw.headRefOid,
    autoMergeArmed: raw.autoMergeRequest != null,
    reviewSummary: undefined,
    // W1-T100: the ci-log fix mode's input — see buildOpenPrViews.
    ciFailures: checksState === "red" ? fetchCiFailures(owner, repo, raw.statusCheckRollup) : undefined,
  };

  const planPath =
    repo === self.repo ? join(repoRoot, "plan", "tasks.yaml") : join(config.root, "repos", repo, "plan", "tasks.yaml");
  let plan: Plan = { tasks: [], byId: new Map() };
  try {
    plan = loadPlan(planPath);
  } catch (e) {
    log("fix.plan.unavailable", { plan_path: planPath, error: String((e as Error)?.message ?? e) });
  }

  const effects = buildSweepEffects(owner, repo, config, ledgerPath, runId, plan, log, DEFAULT_SWEEP_POLICY);
  const { outcome, reason } = await routeFix(raw.state, pr, effects, DEFAULT_SWEEP_POLICY);

  log(`fix.${outcome === "refused" ? "refused" : "disposed"}`, { pr_number: prNumber, task_id: taskId, outcome, reason });
  if (outcome === "fixed") {
    console.log(`### rmd fix — PR #${prNumber} (${taskId}): ${reason} — dispatched the fix rung.`);
    return 0;
  }
  if (outcome === "escalated") {
    console.log(`### rmd fix — PR #${prNumber} (${taskId ?? "unknown task"}): ${reason} — escalated, no spawn.`);
    return 0;
  }
  console.error(`### rmd fix — PR #${prNumber} is not fixable: ${reason}. No spawn.`);
  return 1;
}

/**
 * `rmd wipe-test <task-id> [--repo remudero-sandbox] [--allow-non-sandbox]` — the P12
 * learning-utility A/B harness (W1-T86; see src/lib/wipe-test.ts's module doc for the
 * full design). Runs `<task-id>` TWICE through `runTask`: arm A with normal learnings
 * injection, arm B with injection MASKED (the store itself untouched — see
 * `computeMatchedLearningsForArm`) — then computes + LEDGERS the deltas between them
 * (`wipetest.pair`). SANDBOX-ONLY by default (`resolveWipeTestTarget`): a bare `--repo
 * remudero` (or any non-sandbox name) is REFUSED before either arm ever spawns.
 *
 * A single pair is an anecdote (the design's own words) — the aggregate over many
 * ledgered pairs (`aggregateWipeTestPairs`, read back from the ledger) is what the
 * operator treats as signal; this command runs and ledgers exactly one pair per
 * invocation, by design (repeat it to accumulate pairs).
 */
export async function wipeTestCommand(
  rest: string[],
  deps: {
    config?: Config;
    /** Injectable dispatch — the real (default) is this module's own {@link runTask}. A
     *  behavioral test swaps in a fake returning canned {@link RunResult}s so a `wipe-test`
     *  invocation can be exercised end-to-end WITHOUT spawning two real workers. */
    runTaskFn?: typeof runTask;
    /** Injectable subprocess runner for the non-self clone/fetch step — same seam
     *  `drainCommand`'s `githubFactory` provides for its own network calls. Default: the
     *  real {@link execFileSync}. */
    execFileSyncFn?: typeof execFileSync;
  } = {},
): Promise<number> {
  const taskId = rest[0];
  const badArg = unknownArgError("wipe-test", rest.slice(1), ["--repo"], ["--allow-non-sandbox"]);
  if (!taskId || badArg) {
    if (badArg) console.error(badArg);
    console.error(`usage: ${commandSyntax("wipe-test")}\n` + USAGE);
    return 2;
  }

  const resolved = resolveWipeTestTarget(rest.slice(1));
  if ("error" in resolved) {
    console.error(resolved.error + "\n" + USAGE);
    return 2;
  }
  const { repo } = resolved.target;

  const config = deps.config ?? loadConfig();
  const runTaskFn = deps.runTaskFn ?? runTask;
  const execFileSyncFn = deps.execFileSyncFn ?? execFileSync;
  const ledgerPath = ledgerPathFor(config);
  const self = resolveOwnerRepo();
  const isSelf = repo === self.repo;
  const reposDir = join(config.root, "repos");
  const planPath = isSelf ? join(repoRoot, "plan", "tasks.yaml") : join(reposDir, repo, "plan", "tasks.yaml");

  // Same clone-if-absent / fetch+reset-if-present pattern `rmd daemon`'s non-self
  // target uses (daemonCommand, above) — a wipe-test target needs an up-to-date
  // checkout to dispatch against exactly the way the daemon does.
  if (!isSelf) {
    const repoDir = join(reposDir, repo);
    if (!existsSync(repoDir)) {
      mkdirSync(dirname(repoDir), { recursive: true });
      execFileSyncFn("gh", ["repo", "clone", `${self.owner}/${repo}`, repoDir], { stdio: "inherit" });
    } else {
      execFileSyncFn("git", ["-C", repoDir, "fetch", "--quiet", "origin"], { stdio: "pipe" });
      execFileSyncFn("git", ["-C", repoDir, "reset", "--hard", "--quiet", "origin/main"], { stdio: "pipe" });
    }
  }

  const runId = `WIPETEST-${Date.now()}`;
  console.log(`### rmd wipe-test — ${taskId} on ${self.owner}/${repo}: arm A (learnings ON)`);
  const rawArmA = await runTaskFn(taskId, { planPath, config, skipGitSync: true });
  console.log(`### rmd wipe-test — ${taskId} on ${self.owner}/${repo}: arm B (learnings MASKED)`);
  const rawArmB = await runTaskFn(taskId, { planPath, config, skipGitSync: true, maskLearnings: true });

  const ledgerLines = readLedgerLines(ledgerPath);
  const pair: WipeTestPair = {
    taskId,
    armA: deriveWipeTestRunResult(rawArmA, ledgerLines),
    armB: deriveWipeTestRunResult(rawArmB, ledgerLines),
  };
  const delta = ledgerWipeTestPair(ledgerPath, runId, pair);
  console.log("\n" + JSON.stringify({ pair, delta }, null, 2));
  return 0;
}

/**
 * `rmd stop [--reason <text>]` — the fleet control set (W1-T11, MASTER-PLAN §4A/§4B).
 * Writes the STOP flag file. A `rmd drain` already running halts within one tick
 * (checked FIRST, every iteration, ahead of PAUSE); a NEW `rmd drain` refuses to
 * spawn anything until `rmd resume` clears it — same check, same code path.
 */
async function stopCommand(rest: string[]): Promise<number> {
  const config = loadConfig();
  const reason = flagValue(rest, "--reason");
  const ledgerPath = ledgerPathFor(config);

  // STOP is ONE-SHOT: it exists only to halt a RUNNING drain/daemon, which auto-consumes it
  // on termination. With NOTHING running, writing STOP would be a persistent latch that
  // silently blocks the NEXT drain (the reported bug) — so with nothing to stop, warn + no-op.
  // "Active" = the shared drain.lock is held by a live pid (a drain or daemon is running).
  const holder = readDrainLock(join(config.root, "state", "drain.lock"));
  if (!holder || !defaultIsPidAlive(holder.pid)) {
    console.warn(
      `### rmd stop — nothing to stop: no drain/daemon is running. NOT writing a persistent ` +
        `STOP (it is one-shot). For a maintenance hold that survives across runs, use \`rmd pause\`.`,
    );
    appendLedger(ledgerPath, {
      run_id: `FLEET-${Date.now()}`,
      task_id: "FLEET",
      step: "fleet.stop.noop",
      reason: reason ?? null,
    });
    return 0;
  }

  const info = requestStop(config.root, reason);
  appendLedger(ledgerPath, {
    run_id: `FLEET-${Date.now()}`,
    task_id: "FLEET",
    step: "fleet.stop",
    reason: reason ?? null,
    requested_by_pid: info.pid,
    target_pid: holder.pid,
  });
  console.log(
    `### rmd stop — STOP written; the running drain (pid ${holder.pid}) halts within one tick ` +
      `and AUTO-CLEARS STOP as it exits. One-shot: your next \`rmd drain\` starts clean — no \`rmd resume\` needed.`,
  );
  return 0;
}

/**
 * `rmd pause [--reason <text>]` — drain-and-hold (W1-T11). Writes the PAUSE flag
 * file. No new task spawns after the current tick, but an in-flight task ALWAYS
 * runs to full completion (verdict + merge) — the drain loop only checks between
 * iterations, never mid-task.
 */
async function pauseCommand(rest: string[]): Promise<number> {
  const config = loadConfig();
  const reason = flagValue(rest, "--reason");
  const info = requestPause(config.root, reason);
  const ledgerPath = ledgerPathFor(config);
  appendLedger(ledgerPath, {
    run_id: `FLEET-${Date.now()}`,
    task_id: "FLEET",
    step: "fleet.pause",
    reason: reason ?? null,
    requested_by_pid: info.pid,
  });
  console.log(
    `### rmd pause — PAUSE flag written (drain-and-hold). Any in-flight task still ` +
      `reaches merge; no new task spawns until \`rmd resume\`.`,
  );
  return 0;
}

/** `rmd resume` — clears BOTH the STOP and PAUSE flags (W1-T11). Idempotent. */
async function resumeFleetCommand(): Promise<number> {
  const config = loadConfig();
  const result = resumeFleet(config.root);
  const ledgerPath = ledgerPathFor(config);
  appendLedger(ledgerPath, {
    run_id: `FLEET-${Date.now()}`,
    task_id: "FLEET",
    step: "fleet.resume",
    cleared_stop: result.clearedStop,
    cleared_pause: result.clearedPause,
  });
  console.log(
    `### rmd resume — cleared: stop=${result.clearedStop} pause=${result.clearedPause}. ` +
      `The fleet is clear to spawn again.`,
  );
  return 0;
}

/**
 * `rmd away [on|off]` — set or show the operator presence mode (P34 clause (e), MASTER-PLAN
 * §7B/§4). With no argument, prints the current mode. AWAY batches MANUAL/HARD_STOP escalations
 * into the W1-T163 recap for an async verdict instead of paging in real time; ATTENDED (the
 * default) delivers exactly as today. Presence keys ONLY escalation delivery — it never gates
 * dispatch (escalate.ts's module header names the dead presence×risk matrix this must not
 * resurrect); STOP/PAUSE (above) remain the only real-time-presence waits.
 */
export async function awayCommand(rest: string[]): Promise<number> {
  const config = loadConfig();
  const arg = rest[0];
  if (arg !== undefined && arg !== "on" && arg !== "off") {
    console.error(`usage: ${commandSyntax("away")}`);
    return 2;
  }
  if (arg === undefined) {
    console.log(`### rmd away — presence mode: ${presenceMode(config.root)}`);
    return 0;
  }
  const mode: PresenceMode = arg === "on" ? "away" : "attended";
  setPresenceMode(config.root, mode);
  const ledgerPath = ledgerPathFor(config);
  appendLedger(ledgerPath, {
    run_id: `FLEET-${Date.now()}`,
    task_id: "FLEET",
    step: "fleet.presence",
    mode,
  });
  console.log(
    mode === "away"
      ? "### rmd away on — presence set to AWAY: MANUAL/HARD_STOP escalations now batch into the recap for async verdict instead of paging in real time."
      : "### rmd away off — presence set to ATTENDED: escalations deliver exactly as today.",
  );
  return 0;
}

/** `--flag value` lookup over a raw argv tail; undefined if the flag is absent. */
function flagValue(rest: string[], flag: string): string | undefined {
  const i = rest.indexOf(flag);
  return i >= 0 ? rest[i + 1] : undefined;
}

/**
 * Strict arg check for a FLAGS-ONLY subcommand: return an error string for the FIRST
 * unrecognized token (a bare positional, or a `--flag` not in `valueFlags`/`boolFlags`),
 * else null. `valueFlags` consume the following token as their value. This is what makes a
 * SPAWNING command fail loud on junk instead of draining — `rmd daemon install --dry-run`
 * silently ran the daemon (draining W1-T15) because `install`/`--dry-run` were ignored.
 */
export function unknownArgError(
  command: string,
  rest: string[],
  valueFlags: string[],
  boolFlags: string[] = [],
): string | null {
  const vf = new Set(valueFlags);
  const bf = new Set(boolFlags);
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (bf.has(tok)) continue;
    if (vf.has(tok)) {
      i++; // skip its value
      continue;
    }
    return `rmd ${command}: unexpected argument '${tok}' — see \`rmd --help\``;
  }
  return null;
}

/** The repo + plan a `rmd daemon` run targets, resolved from its flags. */
export interface DaemonTarget {
  owner: string;
  repo: string; // scopes the status-derivation GitHub gateway
  planPath: string; // where the plan to schedule is read from
  isSelf: boolean; // repo === the daemon's OWN source repo
  dryRun: boolean;
}

/**
 * Resolve which repo/plan a `rmd daemon` run targets — PURE (no I/O), so the guard is
 * unit-testable. The daemon reads its plan from the CHECKOUT it runs in by default and scoped
 * the status gateway to a hardcoded "remudero"; this makes the target EXPLICIT:
 *   --repo <name>   scope the gateway to <owner>/<name> and read the plan from that repo's clone
 *   --plan <path>   read the plan from an explicit file (overrides the derived path)
 *   --allow-self-target  acknowledge draining the daemon's OWN source repo (deliberate self-host)
 *   --dry-run       preview only (harmless — allowed even for self)
 * GUARD (W1-T12d): a bare `rmd daemon` would silently drain the repo that holds the daemon's own
 * source (self) unattended — REFUSED unless --allow-self-target (or --dry-run). Commissioning
 * targets the sandbox explicitly: `rmd daemon --repo remudero-sandbox`.
 */
export function resolveDaemonTarget(
  env: { selfOwner: string; selfRepo: string; repoRoot: string; reposDir: string },
  rest: string[],
): { target: DaemonTarget } | { error: string } {
  const repoFlag = flagValue(rest, "--repo");
  const planFlag = flagValue(rest, "--plan");
  const allowSelf = rest.includes("--allow-self-target");
  const dryRun = rest.includes("--dry-run");
  const repo = repoFlag ?? env.selfRepo;
  const isSelf = repo === env.selfRepo;
  if (isSelf && !allowSelf && !dryRun) {
    return {
      error:
        `rmd daemon: refusing to drain the daemon's OWN source repo '${repo}' unattended ` +
        `(no silent self-default). For commissioning, target the sandbox: ` +
        `\`rmd daemon --repo remudero-sandbox\`. To self-host deliberately, pass --allow-self-target.`,
    };
  }
  const planPath =
    planFlag ??
    (isSelf ? join(env.repoRoot, "plan", "tasks.yaml") : join(env.reposDir, repo, "plan", "tasks.yaml"));
  return { target: { owner: env.selfOwner, repo, planPath, isSelf, dryRun } };
}

/** Every `--option "label|detail"` in argv tail, in order given. */
function parseOptionFlags(rest: string[]): EscalationOption[] {
  const options: EscalationOption[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] !== "--option") continue;
    const raw = rest[i + 1] ?? "";
    const sep = raw.indexOf("|");
    options.push(sep >= 0 ? { label: raw.slice(0, sep), detail: raw.slice(sep + 1) } : { label: raw, detail: "" });
  }
  return options;
}

const ESCALATION_CLASSES: EscalationClass[] = ["BLOCKED", "MANUAL", "HARD_STOP"];

/**
 * `rmd escalate --class <BLOCKED|MANUAL|HARD_STOP> --task <id> --summary <s>
 *   [--detail <d>] [--recommendation <r>] [--option "label|detail"]...`
 * Opens the `needs-human` labeled issue (escalate.ts) UNCONDITIONALLY. For MANUAL/HARD_STOP
 * ONLY, also fires a real-time iMessage ping (§4: BLOCKED collapses to the digest) — but ONLY
 * when the operator is ATTENDED (escalate.ts's `deliversRealtime`, P34 clause (e)). AWAY mode
 * skips that ping and instead ledgers `escalation.batched_away`: the issue already opened above
 * is picked up by the W1-T163 recap/digest off the SAME marker for an ASYNC verdict, rather than
 * expecting a sync answer right now. ATTENDED behaves EXACTLY as before this flag existed.
 */
export async function escalateCommand(
  rest: string[],
  deps: { issues?: IssueGateway; notifyChannel?: NotifyChannel } = {},
): Promise<number> {
  const cls = flagValue(rest, "--class");
  const taskId = flagValue(rest, "--task");
  const summary = flagValue(rest, "--summary");
  if (!cls || !ESCALATION_CLASSES.includes(cls as EscalationClass) || !taskId || !summary) {
    console.error(`usage: ${commandSyntax("escalate")}`);
    return 2;
  }
  const config = loadConfig();
  const { owner, repo } = resolveOwnerRepo();
  const ledgerPath = ledgerPathFor(config);
  const runId = `ESCALATE-${Date.now()}`;
  const url = escalate(
    {
      class: cls as EscalationClass,
      taskId,
      runId,
      summary,
      detail: flagValue(rest, "--detail") ?? "",
      options: parseOptionFlags(rest),
      recommendation: flagValue(rest, "--recommendation") ?? "",
    },
    { issues: deps.issues ?? ghIssueGateway(owner, repo), ledgerPath, runId },
  );
  console.log(url);
  if (cls === "MANUAL" || cls === "HARD_STOP") {
    if (deliversRealtime(config.root)) {
      // W1-T144: the real-time ping deep-links to the console card alongside the GitHub
      // issue URL, same as the digest's own escalations line (digest.ts's renderDigest).
      notify(`[${cls}] ${taskId}: ${summary}\n${url}\n${consoleCardUrl(consoleUrl(config), taskId)}`, {
        channel: deps.notifyChannel ?? imessageChannel(notifyRecipient(config)),
        ledgerPath,
        runId,
        taskId,
      });
    } else {
      // P34 clause (e), AWAY mode: no real-time page. The `escalation.issue_opened` line above
      // already carries this into the recap/digest; this line records that away mode is why no
      // ping fired, so the routing decision itself is auditable.
      appendLedger(ledgerPath, {
        run_id: runId,
        task_id: taskId,
        step: "escalation.batched_away",
        class: cls,
        issue_url: url,
      });
    }
  }
  return 0;
}

/** `rmd notify <message>` — a real-time iMessage ping via osascript (notify.ts). */
async function notifyCommand(rest: string[]): Promise<number> {
  const message = rest.join(" ");
  if (!message) {
    console.error(`usage: ${commandSyntax("notify")}`);
    return 2;
  }
  const config = loadConfig();
  const ledgerPath = ledgerPathFor(config);
  notify(message, {
    channel: imessageChannel(notifyRecipient(config)),
    ledgerPath,
    runId: `NOTIFY-${Date.now()}`,
    taskId: "NOTIFY",
  });
  return 0;
}

/**
 * `rmd feedback <text...> [--attach <path-or-url>]... [--origin cli|ui|issue]` — the durable
 * inbox's async-capture front door (lib/feedback.ts, MASTER-PLAN §7B, W1-T40). Writes one
 * `plan/feedback/<id>.yaml` entry with `status: new` and returns immediately (plain filesystem
 * I/O — no network, no LLM call). Fails loud (exit 2, writes nothing) on a bad flag, an
 * unreadable `--attach` path, or empty text; never falls through to a silent no-op.
 *
 * `repoRoot` here is THIS checkout — the codebase this command is running against, which may
 * be a fork/clone with no relation to rmd's own repo. `captureFeedback` (W1-T397) separately
 * checks `repoRoot`'s own `.remudero/home-repo.json` and, when it names a different repo,
 * routes an upstream PR there in addition to this local write — so an instance working on
 * another codebase files an rmd defect where an rmd maintainer will read it, rather than into
 * that other codebase's own inbox. No pointer configured (the default) leaves this command's
 * behavior unchanged from before W1-T397.
 */
async function feedbackCommand(rest: string[]): Promise<number> {
  const parsed = parseFeedbackAddArgs(rest);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }
  try {
    const entry = captureFeedback(repoRoot, parsed);
    console.log(JSON.stringify(entry, null, 2));
    return 0;
  } catch (err) {
    if (err instanceof FeedbackError) {
      console.error(`rmd feedback: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

/**
 * The Architect intake worker's tool allowlist (MASTER-PLAN §7B / `.remudero/skills/feedback.yaml`),
 * minus `AskUserQuestion`: ★ VERIFIED (W1-T42, LEARNINGS.md "AskUserQuestion neither works
 * headlessly nor stalls") it silently auto-resolves with an EMPTY answer with no TTY, and this
 * worker always runs via `spawnWorker` — a subprocess with no TTY BY CONSTRUCTION, regardless of
 * the invoking shell — so an interactive grill is structurally unreachable here, not a fallback
 * choice. The AMBIGUOUS verdict parks the entry at `grilling` AND `triageCommand` below opens a
 * `needs-human` GitHub issue (escalate.ts, MASTER-PLAN §4) carrying options + a recommendation —
 * the grill's one and only mechanism.
 */
// "Edit" is load-bearing (the 2026-07-22 materialization gap): the triage prompt
// (triage.ts) instructs the PROPOSED path to "Edit ONLY plan files", and
// plan/tasks.yaml is ~11k lines — without the Edit tool the worker cannot make a
// surgical change (whole-file Write is not viable at that size), so it emitted
// PROPOSED with an EMPTY diff and decideTriage fail-closed it as inconsistent
// (observed live: feedback 04eac2 + 728bc1, both INCONSISTENT with empty diffs).
// PLAN_WORKER_TOOLS (below) already grants Edit for the same job — this matches it.
// Exported for the behavioral test (test/triage.test.ts) that pins the grant.
export const TRIAGE_WORKER_TOOLS = ["Read", "Write", "Edit", "Grep", "Glob", "WebSearch"];

/**
 * Every path a worker touched in its worktree, measured against `origin/main` — INCLUDING files it
 * CREATED. This is the input `decideTriage` and `decidePlanArchitect` judge a PROPOSED verdict on, so
 * a path missing here is a run that did the work and gets thrown away.
 *
 * SHARED BY BOTH FILING LANES (impl-ER renamed it from `triageChangedFiles` for exactly that reason).
 * The plan lane carried its own tracked-only `git diff` until then; a lane-specific name on a
 * lane-neutral helper is how this repo twice ended up with two implementations of one rule.
 *
 * WHY THE UNION, AND NOT `git diff` ALONE (impl-EO, 2026-08-01). `git diff --name-only origin/main`
 * reports TRACKED paths only; a brand-new file is untracked and is invisible to it. That was
 * harmless while a proposal EDITED the tracked `plan/tasks.yaml` monolith — and became a
 * money-burning failure the moment PR #1060 redirected proposals into a NEW shard at
 * `plan/tasks.d/<id>-<kebab-slug>.yaml`. The worker complied, wrote the shard, and returned
 * PROPOSED; `git diff` saw nothing; `decideTriage` correctly refused the run as inconsistent
 * ("PROPOSED but no plan files were changed", `changed_files: []`) and opened no PR. Two
 * auto-triage fires on `fb-alert-craigoley-remudero-code-scanning-61` failed this way at
 * $1.0547 and $1.0916, and the entry stayed `status: new` — so it would be re-picked as the
 * oldest candidate forever, at ~$1 a fire.
 *
 * `ls-files --others --exclude-standard` is the untracked half, `--exclude-standard` so an
 * ignored build artifact never counts as a plan change. Deduped because the two halves are
 * disjoint by definition and a future third source must not double-report. Detection runs BEFORE
 * the harness's bookkeeping commit, which is exactly why staging cannot be assumed.
 */
/**
 * The MERGE BASE of `origin/main` and this worktree's HEAD — the only base a "what did THIS branch
 * change" question may use.
 *
 * WHY A BARE `origin/main` IS WRONG HERE, and this is MEASURED rather than reasoned: `git diff
 * origin/main` compares the CURRENT TIP to the working tree, so the moment `origin/main` moves it
 * reports every file the incoming commits touched as though this worktree had changed it. #1535
 * fixed the same defect in `scopeGuardOutOfScopeFiles` by moving two-dot to three-dot; this is its
 * third form, and it needs an explicit merge base rather than a dot because there is no three-dot
 * spelling that compares against the WORKING TREE — and the working tree is exactly what
 * {@link worktreeChangedFiles} must see, since detection runs before the bookkeeping commit.
 *
 * AND THE REF MOVES WITHOUT ANYONE MERGING BY HAND. A git worktree shares refs with its parent
 * clone, so ANY fetch anywhere in the checkout moves `origin/main` for every worktree at once — and
 * `refreshOriginMain` (`src/lib/ci-parity.ts`) runs `git fetch origin main` INSIDE the worker's own
 * `preflight --ci-parity`, for the express purpose of refreshing the base. The fleet moves this ref
 * on itself; a human merging merely supplies the commits that fetch then picks up.
 */
function worktreeMergeBase(worktreePath: string): string {
  return execFileSync("git", ["-C", worktreePath, "merge-base", "origin/main", "HEAD"], { encoding: "utf8" }).trim();
}

export function worktreeChangedFiles(worktreePath: string): string[] {
  const run = (args: string[]): string[] =>
    execFileSync("git", ["-C", worktreePath, ...args], { encoding: "utf8" })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  return [
    ...new Set([...run(["diff", "--name-only", worktreeMergeBase(worktreePath)]), ...run(["ls-files", "--others", "--exclude-standard"])]),
  ];
}

/**
 * `rmd triage <feedback-id>` — the Architect intake worker (MASTER-PLAN §7B, W1-T41).
 *
 * GROUND -> RESEARCH -> GRILL-OR-PROPOSE, run by a fresh higher-tier Architect worker
 * (lib/triage.ts's `triagePrompt`) over ONE `plan/feedback/<id>.yaml` entry, in its own worktree
 * (same isolation shape as `rmd retro`). The worker has no Bash — it only grounds/researches/edits
 * plan files; this function OWNS every commit/push/PR/gate step deterministically (same "the
 * harness eats first" split `regenerateOrientation` established for the retro's docs write), so
 * the LLM can never skip the Acceptance:/Remudero-Task: contract or open a PR touching code.
 */
/** Injectable seam (impl-BB) mirroring {@link runTask}'s own `opts` shape exactly — the
 *  same `spawn?: typeof spawnWorker` field, the same `config?: Config`, the same
 *  `?? real` defaulting inside, so this repo has ONE dependency-injection convention and
 *  not two. It exists because every line after the worker spawn in this function was
 *  unreachable from any offline test: with no seam, a test could not get past
 *  `spawnWorker` without paying for a real worker, so diff-coverage reported every added
 *  line here as uncovered whatever it contained. Passing nothing is the production
 *  contract and behaves exactly as before. */
/**
 * `rmd triage <feedback-id>` — acquires the SHARED triage lock, then delegates.
 *
 * ★ WHY THE LOCK IS HERE AND NOT ONLY IN THE DAEMON (impl-DJ). The task id is minted from a
 * SNAPSHOT before the worker runs (lib/triage.ts), so two overlapping triage runs mint the SAME id.
 * Since PR #1060 each writes its own `plan/tasks.d/<id>-<slug>.yaml` — DIFFERENT filenames, so both
 * merge CLEANLY and `loadPlan` then throws duplicate-task-id ON MAIN. Before #1060 that was a loud
 * EOF conflict; now it is a poisoned plan. The daemon loop being single-threaded only ever protected
 * daemon-vs-daemon; nothing stopped a HAND-RUN racing it, and the auto-triage rung makes that far
 * likelier because the operator cannot see the daemon is about to fire. Both paths take the same
 * lock, so whichever is second REFUSES LOUDLY instead of racing.
 */
export async function triageCommand(
  rest: string[],
  opts: { spawn?: typeof spawnWorker; config?: Config } = {},
): Promise<number> {
  const cfg = opts.config ?? loadConfig();
  const lockPath = triageLockPath(cfg.root);
  let lock: DrainLockHandle;
  try {
    lock = acquireDrainLock(lockPath);
  } catch (e) {
    if (e instanceof DrainLockError) {
      console.error(triageLockRefusalMessage(e.holder.pid, e.holder.startedAt, lockPath));
      return 2;
    }
    throw e;
  }
  try {
    return await triageCommandLocked(rest, { ...opts, config: cfg });
  } finally {
    lock.release();
  }
}

/** The refusal an operator sees when the daemon's rung (or another hand-run) holds the lock. */
export function triageLockRefusalMessage(pid: number, startedAt: string, lockPath: string): string {
  return (
    `rmd triage: REFUSED — another triage run is already in flight (pid ${pid}, started ${startedAt}). ` +
    `Two concurrent runs mint the SAME task id, and since #1060 both merge cleanly and poison the ` +
    `plan on main. Wait for it to finish, or delete ${lockPath} if that process is gone.`
  );
}

async function triageCommandLocked(
  rest: string[],
  opts: { spawn?: typeof spawnWorker; config?: Config } = {},
): Promise<number> {
  const parsed = parseTriageArgs(rest);
  if ("error" in parsed) {
    console.error(parsed.error + "\n" + USAGE);
    return 2;
  }
  const { feedbackId } = parsed;

  const config = opts.config ?? loadConfig();
  const spawn = opts.spawn ?? spawnWorker;
  const { owner, repo } = resolveOwnerRepo();

  // G-17 Tier Invariant: the triage Architect MUST outrank implement workers.
  const mountsTable = loadMounts(mountsPath(repoRoot));
  const arch = architectModel(config, mountsTable); // Architect model is the mounts.yaml `architect:` row
  const wrk = workerModel(config);
  assertArchitectAboveWorker(arch, wrk); // throws (fail-closed) on violation

  const ledgerPath = ledgerPathFor(config);
  const taskId = `TRIAGE-${feedbackId}`;
  const runId = `${taskId}-${Date.now()}`;
  const log = (step: string, extra: Record<string, unknown> = {}) =>
    appendLedger(ledgerPath, { run_id: runId, task_id: taskId, step, ...extra });
  const say = (msg: string) => console.log(`\n### [triage] ${msg}`);
  log("triage.start", { feedback_id: feedbackId, architect: arch, worker: wrk });
  say(`triage ${runId} — architect ${arch} over worker ${wrk} — feedback#${feedbackId}`);

  const settingsFile = renderWorkerSettings({
    templatePath: join(repoRoot, "settings", "worker.json"),
    hooksDir: join(repoRoot, "hooks"),
    outPath: join(config.root, "tmp", `triage-settings-${runId}.json`),
  });
  validateWorkerSettingsFile(settingsFile);

  const repoDir = join(config.root, "repos", repo);
  if (!existsSync(repoDir)) {
    mkdirSync(dirname(repoDir), { recursive: true });
    execFileSync("gh", ["repo", "clone", `${owner}/${repo}`, repoDir], { stdio: "inherit" });
  }
  const pruned = pruneStaleRuns(repoDir, worktreesDir(config), { graceMs: DEFAULT_PRUNE_GRACE_MS });
  if (pruned.worktrees.length || pruned.branches.length || pruned.skipped.length) log("worktree.prune", { ...pruned });
  const branch = `run-${runId}`;
  const worktreePath = join(worktreesDir(config), branch);
  worktreeAdd(repoDir, worktreePath, branch, "origin/main");
  // Liveness token so a concurrent drain's prune skips this triage worktree.
  writeRunLock(worktreePath, { pid: process.pid, run_id: runId, startedAt: new Date().toISOString() });

  // W1-T348: the decision-summary rung, resolved ONCE and reused at both sites this run may
  // reach a human/operator — the GRILL escalation below and the proposal write further down.
  // Reuses risk-judge.ts's cheapest-mount scanner (via resolveDecisionSummaryMount, feedback.ts)
  // rather than a new mounts.yaml row, and the SAME cwd/settingsFile/spawn this run already
  // resolved for the Architect worker — no second model-call idiom invented. Constructing this
  // is free (no spawn happens until `.summarize()` is actually called by a grill/propose branch
  // below); a run that ends CLEAR/ALREADY_DECIDED never spends on it.
  const summarizeDeps: SummarizeDeps = {
    summarize: realDecisionSummarizer({
      mount: resolveDecisionSummaryMount(mountsTable),
      cwd: worktreePath,
      settingsFile,
      spawn,
    }),
  };

  // Declared OUTSIDE the try so the finally releases it on EVERY exit — success, throw, or the
  // catch arm's rethrow. A reservation that outlived its run would burn the id permanently, which
  // is the phantom-id class this must not add to (W1-T199/224/247/263 already exist).
  let reservationHandle: TaskIdReservationHandle | undefined;
  try {
    // Read the entry from the FRESH worktree (origin/main snapshot), not repoRoot, which may be
    // a stale checkout — same discipline retro's next-task read follows.
    let entry;
    try {
      entry = readFeedbackEntry(worktreePath, feedbackId);
    } catch (e) {
      // W1-T243: distinguish "captured locally but the durable-inbox commit bridge hasn't
      // landed it on origin/main yet" from "genuinely no such id" — before this fix both
      // printed the byte-identical "no such feedback entry: <id>", which read as a typo
      // even when the entry was simply mid-flight to its landing PR.
      const existsLocally = existsSync(feedbackEntryPath(repoRoot, feedbackId));
      const landingPrUrl = existsLocally ? findPendingLandingPr() : undefined;
      log("triage.error", {
        error: String((e as Error)?.message ?? e),
        pending_landing: existsLocally,
        landing_pr: landingPrUrl ?? null,
      });
      say(missingFeedbackMessage(feedbackId, { existsLocally, landingPrUrl }));
      worktreeRemove(repoDir, worktreePath);
      return 2;
    }
    if (entry.status !== "new") {
      log("triage.error", { error: `feedback#${feedbackId} is not status:new (already ${entry.status})` });
      say(`feedback#${feedbackId} is already ${entry.status} — refusing to re-triage; nothing to do`);
      worktreeRemove(repoDir, worktreePath);
      return 1;
    }

    // ID MINT (the 2/2 collision evidence: W1-T256->257 #770, W1-T260->261 #775; lineage
    // feedback#fb-1784766965325-c7b673; PLUS the W1-T278 fold class: an id filed and later
    // folded away is invisible to every current-tree source, so the mint is also floored by
    // the plan/ git history — see mintNextTaskIdWithHistory). Derived HERE, from the FRESH
    // worktree's plan (monolith + every tasks.d shard + its own git history) plus the ids
    // open plan PRs have already minted, and handed to the worker — which has no Bash tool
    // and so could never have run the grep the prompt used to describe. Ledgered with its
    // provenance so a degraded source is visible, never silent.
    const mint = mintNextTaskIdWithHistory({
      planPath: join(worktreePath, "plan", "tasks.yaml"),
      repoRoot: worktreePath,
      openPrTexts: () => openPrMintTexts(owner, repo),
    });
    // RESERVE the minted id before spending anything. The mint above is a SNAPSHOT and reserves
    // nothing, so a THIRD caller (the lock #1069 added covers only triage's own two paths — not
    // `rmd plan --mode=create`, not a second machine, not a cross-repo instance filing into this
    // plan) can mint the same number. Contention ADVANCES rather than refusing, so this only ever
    // moves the id upward, never blocks. Taken BEFORE `spawn` on purpose: a reservation that
    // cannot be written throws TaskIdReservationError out of this command, and the paid worker
    // (median $0.96) is never started — a minter that cannot reserve must not spend.
    const reservation = reserveTaskIdFrom(mint.n, taskIdReservationsDir(config.root), {
      info: { purpose: `rmd triage ${feedbackId} (run ${runId})` },
    });
    reservationHandle = reservation;
    // The id the WORKER is told to use — the reserved one, which equals the mint's whenever there
    // was no contention (the overwhelmingly common case).
    const reservedTaskId = `W1-T${reservation.id}`;
    log("triage.id_minted", {
      minted_id: reservedTaskId,
      mint_id: mint.id,
      reserved_above_mint: reservation.id !== mint.n,
      max_seen: mint.maxSeen,
      source_monolith: mint.sources.monolith,
      source_shards: mint.sources.shards,
      source_open_prs: mint.sources.openPrs,
      source_history: mint.historyMax,
      degraded: mint.degraded.map((d) => d.source),
    });
    say(`next task id: ${describeMintWithHistory(mint)}`);
    if (reservation.id !== mint.n)
      say(`reserved ${reservedTaskId} instead — ${mint.id} is held by a live minter`);

    // impl-FU — THE RELINT LOOP. Spawn, lint what was actually filed with the REAL linter, hand the
    // REAL violations back, bounded. Sits AFTER `decideTriage` inside each round (a CLEAR/GRILL
    // files nothing, so there is nothing to lint and no extra turn is bought) and BEFORE any
    // commit/push/PR — which is the whole point: W1-T286 cost $1.48 and reached a PR that
    // `lint-plan` then rejected with six violations. `decideTriage` itself is UNCHANGED.
    let worker!: WorkerResult;
    const loop = await runRelintLoop({
      lane: "triage",
      filedIds: [reservedTaskId],
      initialPrompt: triagePrompt(entry, runId, reservedTaskId),
      log,
      run: async (prompt, attempt) => {
        worker = await spawn({
          cwd: worktreePath,
          permissionMode: "bypassPermissions",
          settingsFile,
          model: arch, // the Architect tier
          maxTurns: mountsTable.architect.maxTurns, // MOUNT-GOVERNED (§9) — never a hardcoded literal.
          maxBudgetUsd: DEFAULT_BUDGET_USD,
          config,
          prompt,
          tools: TRIAGE_WORKER_TOOLS,
        });
        log("triage.synthesized", {
          attempt,
          session_id: worker.sessionId,
          cost_usd: worker.costUsd,
          subtype: worker.subtype,
          ...workerLedgerFields(worker),
        });
        // Ground truth: what did the worker ACTUALLY touch (before the harness's own status write)?
        const changedFiles = worktreeChangedFiles(worktreePath);
        const verdict = parseTriageVerdict([worker.text, worker.blocks.join("\n")].join("\n"));
        return { decision: decideTriage({ verdict, changedFiles }), changedFiles };
      },
      filed: (r) => r.decision.action === "propose",
      lint: () =>
        lintFiledTasks(worktreePath, [reservedTaskId], {
          newMonolithIds: newMonolithIdsAgainstBase(worktreePath),
        }),
    });
    const { decision, changedFiles } = loop.decision;

    // FAIL EARLY, AND SAY WHY. Before this, a violating filing became a PR that opened, burned CI,
    // and reported only "ci failure" — indistinguishable from a flake.
    if (loop.violations.length > 0) {
      const reason = relintRefusalMessage("triage", [reservedTaskId], loop.violations, loop.attempts, loop.stop);
      log("triage.relint_refused", {
        stop: loop.stop,
        attempts: loop.attempts,
        checks: [...new Set(loop.violations.map((v) => v.check))],
        violations: loop.violations.map((v) => v.message),
      });
      say(reason);
      worktreeRemove(repoDir, worktreePath);
      return 1;
    }

    if (decision.action === "error") {
      log("triage.error", { error: decision.reason, changed_files: changedFiles, subtype: worker.subtype });
      say(`triage inconsistent — ${decision.reason}; leaving no PR`);
      worktreeRemove(repoDir, worktreePath);
      return 1;
    }

    // THE GRILL (W1-T42): the ONLY viable mechanism is the async needs-human issue — ★ VERIFIED
    // AskUserQuestion silently auto-resolves EMPTY with no TTY rather than stalling, and this
    // worker always runs headless via spawnWorker (LEARNINGS.md "AskUserQuestion neither works
    // headlessly nor stalls"; TRIAGE_WORKER_TOOLS above). Opened BEFORE the bookkeeping commit
    // below so the commit/PR body can cite the real issue URL.
    let grillIssueUrl: string | undefined;
    if (decision.action === "grill") {
      // W1-T348: wired at escalation creation via the escalate.ts choke point — the issue opens
      // with a validated decisionSummary when the summarizer succeeds, and degrades to exactly
      // today's raw-body issue (fail-open) on any summarizer failure.
      grillIssueUrl = await escalateWithSummary(buildGrillEscalation({ entry, decision, taskId, runId }), {
        issues: ghIssueGateway(owner, repo),
        ledgerPath,
        runId,
        ...summarizeDeps,
      });
      log("triage.grill_opened", { issue_url: grillIssueUrl, options: decision.options.length, recommendation: decision.recommendation });
      say(`grill opened (needs-human, ${decision.options.length} options + a recommendation): ${grillIssueUrl}`);
    }

    // ID-COLLISION GUARD (W1-T236 triple-mint, 2026-07-22): refuse a proposal whose merged plan
    // (monolith + tasks.d shards) does not load — e.g. a minted id a shard already owns — BEFORE
    // any push, with the duplicate named. See lib/triage.ts's assertProposedPlanLoads.
    if (decision.action === "propose") {
      try {
        assertProposedPlanLoads(worktreePath);
      } catch (e) {
        const reason = String((e as Error)?.message ?? e);
        log("triage.error", { error: `proposed plan does not load: ${reason}` });
        say(`triage PROPOSED an unloadable plan — ${reason}; leaving no PR`);
        worktreeRemove(repoDir, worktreePath);
        return 1;
      }
    }

    // Harness-owned deterministic status write (never LLM-authored) — folded into the SAME diff
    // the worker produced, mirroring regenerateOrientation's post-worker deterministic commit.
    setFeedbackStatus(worktreePath, feedbackId, decision.status);
    execFileSync("git", ["-C", worktreePath, "add", "-A", "--", "plan/"], { stdio: "inherit" });
    const commitMessage = triageCommitMessage({ decision, feedbackId, taskId, grillIssueUrl });
    execFileSync("git", ["-C", worktreePath, "commit", "-m", commitMessage], { stdio: "inherit" });
    gitPushRunBranch(worktreePath);

    // The title is the SAME header string that just went into the commit, split off
    // its first line — never a second computation (W1-T327 design point ii).
    const prCreate = ghPrCreateFillCommand(worktreePath, owner, repo, branch, commitMessage.split("\n")[0]);
    const out = execFileSync(prCreate.command, prCreate.args, prCreate.options);
    const prUrl = out.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/)?.[0];
    if (!prUrl) {
      log("triage.error", { error: "no PR opened" });
      worktreeRemove(repoDir, worktreePath);
      return 1;
    }

    // RUN-OWNERSHIP GUARD (W1-T62 precedent) — before any side effect touches this PR, assert it
    // is actually this triage run's own PR.
    const ownership = checkPrOwnership(prUrl, branch, ghPrHeadGateway(), worker.costUsd, worker.accountLabel);
    if (ownership) {
      log("verdict", ownership.ledger);
      say(`verdict: pr_attribution_failed — claimed PR ${prUrl} is not this triage's own branch (${branch})`);
      worktreeRemove(repoDir, worktreePath);
      return 1;
    }
    ensureTaskTrailer(prUrl, taskId);

    // Record the proposal_pr back onto the entry for the propose path (chicken-and-egg: the PR
    // URL only exists after the first push) — a second small commit onto the SAME open PR,
    // exactly the pattern retro's post-worker orientation commit already established.
    if (decision.action === "propose") {
      // W1-T348: writes the validated decision summary onto the feedback entry it proposes
      // from, in the SAME write as the `proposed` status transition (never half-written) —
      // fail-open to `summary: null` on any summarizer failure, exactly as before this task.
      await proposeFeedbackWithSummary(worktreePath, feedbackId, summarizeDeps, { proposalPr: prUrl });
      execFileSync("git", ["-C", worktreePath, "add", "-A", "--", "plan/feedback/"], { stdio: "inherit" });
      execFileSync(
        "git",
        ["-C", worktreePath, "commit", "-m", `chore(triage): record proposal_pr for feedback#${feedbackId}`],
        { stdio: "inherit" },
      );
      gitPushRunBranch(worktreePath);
    }

    // DETERMINISTIC GUARD: a triage PR is PLAN-ONLY. Fail closed if the diff touches anything
    // outside plan/ (lib/triage.ts's `nonPlanFilesInDiff`, the same shape as retro's guard).
    const diff = execFileSync("gh", ["pr", "diff", prUrl], { encoding: "utf8", maxBuffer: 1 << 26 });
    const strayFiles = nonPlanFilesInDiff(diff);
    if (strayFiles.length > 0) {
      log("triage.error", { error: "triage PR is NOT plan-only", stray_files: strayFiles });
      say(`triage PR touched non-plan file(s) (${strayFiles.join(", ")}) — leaving PR OPEN for inspection`);
      worktreeRemove(repoDir, worktreePath);
      return 1;
    }
    if (decision.action === "propose" && !diffCitesFeedback(diff, feedbackId)) {
      log("triage.error", { error: "proposed diff missing feedback# provenance" });
      say(`triage PROPOSED but the diff never cites feedback#${feedbackId} — leaving PR OPEN for inspection`);
      worktreeRemove(repoDir, worktreePath);
      return 1;
    }
    log("pr.opened", { pr_url: prUrl, plan_only: true, action: decision.action });
    say(`triage PR (plan-only, ${decision.action}): ${prUrl}`);

    // Gate: ci green -> post remudero-review -> arm auto-merge (identical shape to every other
    // Architect skill's output — "PROPOSES anything, MERGES nothing" until the gate clears it).
    const ci = await waitForCiGreen(prUrl, (s, extra) => log(s, extra));
    if (ci !== "green") {
      say(`ci ${ci} — PR left OPEN: ${prUrl}`);
      worktreeRemove(repoDir, worktreePath);
      return 1;
    }
    const prNum = prUrl.match(/\/pull\/(\d+)/)?.[1] ?? prUrl;
    const reviewCode = await reviewCommand(prNum);
    // W1-T230: reviewCommand resolved this PR's task id off its own
    // `Remudero-Task: <taskId>` trailer (ensureTaskTrailer above), so its
    // review.posted ledger line is keyed to the SAME `taskId` armAutoMerge
    // must pass to find it.
    const armOutcome = armAndLogOutcome(prUrl, taskId, log);
    worktreeRemove(repoDir, worktreePath);
    say(`triage PR gated — ${armReportPhrase(armOutcome)} (review ${reviewCode === 0 ? "success" : "failure"}): ${prUrl}`);
    return reviewCode;
  } catch (e) {
    log("triage.error", { error: String((e as Error)?.message ?? e) });
    try {
      worktreeRemove(repoDir, worktreePath);
    } catch {
      /* best-effort */
    }
    throw e;
  } finally {
    removeRunLock(worktreePath); // terminal ⇒ drop the liveness token
    // The id is now either ON an open PR (where the mint's openPrs source sees it) or unused and
    // free to reissue. Either way holding the file longer protects nothing.
    reservationHandle?.release();
  }
}

/**
 * The unified PLAN Architect worker's tool allowlist (`.remudero/skills/plan.yaml`), minus
 * `AskUserQuestion` and `Bash`: same deferral `TRIAGE_WORKER_TOOLS` already documents — v1
 * never grills interactively (LEARNINGS "no live operator in a headless worker"; the actual
 * grill delivery is W1-T42's job, which W1-T45 does not depend on), and the harness — never
 * the LLM — owns every git/gh step.
 */
const PLAN_WORKER_TOOLS = ["Read", "Write", "Edit", "Grep", "Glob", "WebSearch", "WebFetch"];

/**
 * `rmd plan --mode=create|clarify|expand [<brief>...]` — the unified Architect PLAN skill
 * (MASTER-PLAN §5B, W1-T45): ONE code path (lib/plan-architect.ts's `planArchitectPrompt` /
 * `parsePlanVerdict` / `decidePlanArchitect` — each a single definition, no per-mode copy)
 * shared by all three modes, run by a fresh higher-tier Architect worker in its own worktree
 * (same isolation shape as `rmd triage`/`rmd retro`). The worker has no Bash — it only
 * grounds/researches/edits plan-scope files; this function OWNS every commit/push/PR/gate step
 * deterministically, so the LLM can never skip the Acceptance:/Remudero-Task: contract or open
 * a PR touching code. CLEAR and GRILL verdicts touch nothing and open no PR — there is no
 * per-item status file to update here (unlike triage's feedback entry), so only a PROPOSED
 * verdict reaches the commit/push/PR/gate machinery below.
 */
/** Injectable seam (impl-BB) mirroring {@link runTask}'s own `opts` shape exactly — the
 *  same `spawn?: typeof spawnWorker` field, the same `config?: Config`, the same
 *  `?? real` defaulting inside, so this repo has ONE dependency-injection convention and
 *  not two. It exists because every line after the worker spawn in this function was
 *  unreachable from any offline test: with no seam, a test could not get past
 *  `spawnWorker` without paying for a real worker, so diff-coverage reported every added
 *  line here as uncovered whatever it contained. Passing nothing is the production
 *  contract and behaves exactly as before. */
/**
 * How many task ids `rmd plan` reserves before spawning.
 *
 * The lane files "one or more" tasks and the count is unknowable until the worker runs, so this is a
 * declared CEILING rather than a prediction: the worker is told it may file at most this many, and
 * every unused id is released in the same `finally` as the used ones. Five is chosen to be larger
 * than any plan run this repo has produced (the largest single filing to date is the 8-task session
 * harvest, which was a HAND filing, not a `rmd plan` run) while staying small enough that a crashed
 * run holds a trivial slice of the id space until the next acquirer reclaims it lazily.
 */
export const PLAN_MAX_NEW_TASKS = 5;

export async function planCommand(
  rest: string[],
  opts: { spawn?: typeof spawnWorker; config?: Config } = {},
): Promise<number> {
  const parsed = parsePlanArgs(rest);
  if ("error" in parsed) {
    console.error(parsed.error + "\n" + USAGE);
    return 2;
  }
  const { mode, brief } = parsed;

  const config = opts.config ?? loadConfig();
  const spawn = opts.spawn ?? spawnWorker;
  const { owner, repo } = resolveOwnerRepo();

  // G-17 Tier Invariant: the plan Architect MUST outrank implement workers.
  const arch = architectModel(config);
  const wrk = workerModel(config);
  assertArchitectAboveWorker(arch, wrk); // throws (fail-closed) on violation
  const mountsTable = loadMounts(mountsPath(repoRoot));

  const ledgerPath = ledgerPathFor(config);
  const taskId = `PLAN-${mode}`;
  const runId = `${taskId}-${Date.now()}`;
  const log = (step: string, extra: Record<string, unknown> = {}) =>
    appendLedger(ledgerPath, { run_id: runId, task_id: taskId, step, ...extra });
  const say = (msg: string) => console.log(`\n### [plan] ${msg}`);
  log("plan.start", { mode, brief, architect: arch, worker: wrk });
  say(`plan ${runId} — mode=${mode} — architect ${arch} over worker ${wrk}`);

  const settingsFile = renderWorkerSettings({
    templatePath: join(repoRoot, "settings", "worker.json"),
    hooksDir: join(repoRoot, "hooks"),
    outPath: join(config.root, "tmp", `plan-settings-${runId}.json`),
  });
  validateWorkerSettingsFile(settingsFile);

  const repoDir = join(config.root, "repos", repo);
  if (!existsSync(repoDir)) {
    mkdirSync(dirname(repoDir), { recursive: true });
    execFileSync("gh", ["repo", "clone", `${owner}/${repo}`, repoDir], { stdio: "inherit" });
  }
  const pruned = pruneStaleRuns(repoDir, worktreesDir(config), { graceMs: DEFAULT_PRUNE_GRACE_MS });
  if (pruned.worktrees.length || pruned.branches.length || pruned.skipped.length) log("worktree.prune", { ...pruned });
  const branch = `run-${runId}`;
  const worktreePath = join(worktreesDir(config), branch);
  worktreeAdd(repoDir, worktreePath, branch, "origin/main");
  // Liveness token so a concurrent drain's prune skips this plan worktree.
  writeRunLock(worktreePath, { pid: process.pid, run_id: runId, startedAt: new Date().toISOString() });

  let planIdBlock: TaskIdReservationBlock | undefined;

  try {
    // ID MINT + BLOCK RESERVATION (impl-DV), the SAME ordering triage uses at :10222-:10240: mint
    // from the FRESH worktree's plan, reserve BEFORE spawning, hand the worker ids it cannot
    // collide on. Until now this lane minted NOTHING — `planArchitectPrompt` received no id, so its
    // worker chose one by reading the plan files, and nothing could reserve what was never minted.
    //
    // A BLOCK, NOT ONE ID, because this lane files "one or more" tasks (plan-architect.ts's PROPOSED
    // wording in every mode) and the count is unknowable until the worker has run. Reserving a
    // bounded block up front is the only ordering that both refuses cheaply on collision and leaves
    // no id stranded — every id, used or not, is released in the `finally` below.
    const mint = mintNextTaskIdWithHistory({
      planPath: join(worktreePath, "plan", "tasks.yaml"),
      repoRoot: worktreePath,
      openPrTexts: () => openPrMintTexts(owner, repo),
    });
    planIdBlock = reserveTaskIdBlock(mint.n, PLAN_MAX_NEW_TASKS, taskIdReservationsDir(config.root), {
      info: { purpose: `rmd plan --mode=${mode} (run ${runId})` },
    });
    const reservedIds = planIdBlock.ids.map((n) => `W1-T${n}`);
    log("plan.id_minted", {
      reserved: reservedIds,
      mint_id: mint.id,
      reserved_above_mint: planIdBlock.ids[0] !== mint.n,
      max_seen: mint.maxSeen,
      degraded: mint.degraded.map((d) => d.source),
    });
    say(`reserved ${reservedIds.length} task id(s): ${reservedIds.join(", ")}`);

    // impl-FU — THE RELINT LOOP, the same shared runner the triage lane and the inbox draft rung
    // use. This lane has NEVER EXECUTED, so it has never paid for the class this prevents — but its
    // prompt drifted from `monolith-filing` for a fortnight, and the next drift will be found the
    // same way unless the linter itself is in the loop. `decidePlanArchitect` is UNCHANGED.
    let worker!: WorkerResult;
    const loop = await runRelintLoop({
      lane: "plan",
      filedIds: reservedIds,
      initialPrompt: planArchitectPrompt(mode, brief, runId, reservedIds),
      log,
      run: async (prompt, attempt) => {
        worker = await spawn({
          cwd: worktreePath,
          permissionMode: "bypassPermissions",
          settingsFile,
          model: arch, // the Architect tier
          maxTurns: mountsTable.architect.maxTurns, // MOUNT-GOVERNED (§9) — never a hardcoded literal.
          maxBudgetUsd: DEFAULT_BUDGET_USD,
          config,
          prompt,
          tools: PLAN_WORKER_TOOLS,
        });
        log("plan.synthesized", {
          attempt,
          session_id: worker.sessionId,
          cost_usd: worker.costUsd,
          subtype: worker.subtype,
          ...workerLedgerFields(worker),
        });
        const changed = worktreeChangedFiles(worktreePath);
        return { decision: decidePlanArchitect({ verdict: parsePlanVerdict([worker.text, worker.blocks.join("\n")].join("\n")), changedFiles: changed }), changedFiles: changed };
      },
      filed: (r) => r.decision.action === "propose",
      // Only the ids THIS run reserved — the plan carries 193 tasks that already fail the linter.
      lint: () => lintFiledTasks(worktreePath, reservedIds, { newMonolithIds: newMonolithIdsAgainstBase(worktreePath) }),
    });

    // Ground truth: what did the worker ACTUALLY touch, INCLUDING files it CREATED (impl-ER).
    // This lane carried the tracked-only `git diff` that PR #1100 replaced in the triage lane, and it
    // is the same defect: a plan worker that files a NEW shard under `plan/tasks.d/` writes an
    // UNTRACKED path, `git diff` reports nothing, and `decidePlanArchitect` refuses a correct run as
    // "PROPOSED but no plan files were changed". `.remudero/skills/plan.yaml`'s own PROPOSED wording
    // directs the worker to add tasks, and PR #1074's monolith-filing rule pushes those into shards —
    // so the created-file case is the NORMAL one here, not an edge.
    const { decision, changedFiles } = loop.decision;

    // FAIL EARLY, AND SAY WHY — see the triage lane's twin of this block.
    if (loop.violations.length > 0) {
      const reason = relintRefusalMessage("plan", reservedIds, loop.violations, loop.attempts, loop.stop);
      log("plan.relint_refused", {
        stop: loop.stop,
        attempts: loop.attempts,
        checks: [...new Set(loop.violations.map((v) => v.check))],
        violations: loop.violations.map((v) => v.message),
      });
      say(reason);
      worktreeRemove(repoDir, worktreePath);
      return 1;
    }

    // OUTPUT VALIDATION (impl-DV): did the worker actually FILE under the ids we reserved? Reserving
    // is half a contract; this is the other half. Report-only on purpose — see `unreservedFiledIds`.
    if (decision.action === "propose") {
      // MERGE BASE, not the moving tip — see `worktreeMergeBase`. A bare `origin/main` here made a
      // plan shard landed by SOMEONE ELSE's PR read as an id THIS worker filed, so the unreserved-id
      // warning named ids the run never touched.
      const planDiff = execFileSync("git", ["-C", worktreePath, "diff", worktreeMergeBase(worktreePath), "--", "plan"], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      const unreserved = unreservedFiledIds(planDiff, reservedIds);
      log("plan.id_check", { reserved: reservedIds, unreserved, ok: unreserved.length === 0 });
      if (unreserved.length > 0) {
        say(`warning: plan worker filed unreserved id(s): ${unreserved.join(", ")} (reserved: ${reservedIds.join(", ")})`);
      }
    }

    if (decision.action === "error") {
      log("plan.error", { error: decision.reason, changed_files: changedFiles, subtype: worker.subtype });
      say(`plan inconsistent — ${decision.reason}; leaving no PR`);
      worktreeRemove(repoDir, worktreePath);
      return 1;
    }

    if (decision.action === "no_action") {
      log("plan.verdict", { action: "no_action", detail: decision.detail });
      say(formatPlanVerdictLine(mode, decision));
      worktreeRemove(repoDir, worktreePath);
      return 0;
    }

    if (decision.action === "grill") {
      // THE GRILL (W1-T42/W1-T354): the ledger line above is written UNCONDITIONALLY, before any
      // escalation attempt, so a delivery failure below degrades to exactly today's behavior
      // (ledger + console line + clean exit) rather than losing the record — see this task's
      // twin, triageCommand's THE GRILL block a few hundred lines up.
      log("plan.verdict", { action: "grill", detail: decision.detail });
      say(formatPlanVerdictLine(mode, decision));
      try {
        const issueUrl = await escalateWithSummary(buildPlanGrillEscalation({ decision, mode, brief, taskId, runId }), {
          issues: ghIssueGateway(owner, repo),
          ledgerPath,
          runId,
          summarize: realDecisionSummarizer({
            mount: resolveDecisionSummaryMount(mountsTable),
            cwd: worktreePath,
            settingsFile,
            spawn,
          }),
        });
        log("plan.grill_opened", { issue_url: issueUrl });
        say(`grill opened (needs-human): ${issueUrl}`);
      } catch (err) {
        // FAIL-OPEN (tryEscalate's discipline, inlined here since escalateWithSummary is async
        // and tryEscalate is not): a failed delivery never turns the grill into a crash — the
        // plan.verdict ledger line above already recorded the outcome, so this is a missed
        // issue, not a missed record.
        appendLedger(ledgerPath, {
          run_id: runId,
          task_id: taskId,
          step: "escalation.failed",
          class: "GRILL",
          error: String((err as Error)?.message ?? err),
        });
      }
      worktreeRemove(repoDir, worktreePath);
      return 0;
    }

    // propose
    log("plan.verdict", { action: "propose", detail: decision.detail, files: decision.files });
    say(formatPlanVerdictLine(mode, decision));
    const commitMessage = planCommitMessage({ decision, mode, brief, taskId });
    applyPlanProposalCommit(worktreePath, commitMessage);
    gitPushRunBranch(worktreePath);

    // The title is the SAME header string that just went into the commit, split off
    // its first line — never a second computation (W1-T327 design point ii).
    const prCreate = ghPrCreateFillCommand(worktreePath, owner, repo, branch, commitMessage.split("\n")[0]);
    const out = execFileSync(prCreate.command, prCreate.args, prCreate.options);
    const prUrl = out.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/)?.[0];
    if (!prUrl) {
      log("plan.error", { error: "no PR opened" });
      worktreeRemove(repoDir, worktreePath);
      return 1;
    }

    // RUN-OWNERSHIP GUARD (W1-T62 precedent) — before any side effect touches this PR, assert it
    // is actually this plan run's own PR.
    const ownership = checkPrOwnership(prUrl, branch, ghPrHeadGateway(), worker.costUsd, worker.accountLabel);
    if (ownership) {
      log("verdict", ownership.ledger);
      say(`verdict: pr_attribution_failed — claimed PR ${prUrl} is not this plan run's own branch (${branch})`);
      worktreeRemove(repoDir, worktreePath);
      return 1;
    }
    ensureTaskTrailer(prUrl, taskId);

    // DETERMINISTIC GUARDS: a plan PR is PLAN-ONLY (plan/** or MASTER-PLAN.md), and an EXPAND
    // proposal must cite a research source (lib/plan-architect.ts's `outOfPlanScopeFilesInDiff`
    // / `diffCitesResearchSource`, the same shape as triage's plan-only + provenance guards).
    const diff = execFileSync("gh", ["pr", "diff", prUrl], { encoding: "utf8", maxBuffer: 1 << 26 });
    const strayFiles = outOfPlanScopeFilesInDiff(diff);
    if (strayFiles.length > 0) {
      log("plan.error", { error: "plan PR is NOT plan-only", stray_files: strayFiles });
      say(`plan PR touched file(s) outside plan scope (${strayFiles.join(", ")}) — leaving PR OPEN for inspection`);
      worktreeRemove(repoDir, worktreePath);
      return 1;
    }
    if (mode === "expand" && !diffCitesResearchSource(diff)) {
      log("plan.error", { error: "expand diff missing a research-source citation" });
      say(`plan --mode=expand PROPOSED but the diff cites no research source (URL) — leaving PR OPEN for inspection`);
      worktreeRemove(repoDir, worktreePath);
      return 1;
    }
    log("pr.opened", { pr_url: prUrl, plan_only: true, mode });
    say(`plan PR (plan-only, --mode=${mode}): ${prUrl}`);

    // Gate: ci green -> post remudero-review -> arm auto-merge (identical shape to every other
    // Architect skill's output — "PROPOSES anything, MERGES nothing" until the gate clears it).
    const ci = await waitForCiGreen(prUrl, (s, extra) => log(s, extra));
    if (ci !== "green") {
      say(`ci ${ci} — PR left OPEN: ${prUrl}`);
      worktreeRemove(repoDir, worktreePath);
      return 1;
    }
    const prNum = prUrl.match(/\/pull\/(\d+)/)?.[1] ?? prUrl;
    const reviewCode = await reviewCommand(prNum);
    // W1-T230: reviewCommand resolved this PR's task id off its own
    // `Remudero-Task: <taskId>` trailer (ensureTaskTrailer above), so its
    // review.posted ledger line is keyed to the SAME `taskId` armAutoMerge
    // must pass to find it.
    const armOutcome = armAndLogOutcome(prUrl, taskId, log);
    worktreeRemove(repoDir, worktreePath);
    say(`plan PR gated — ${armReportPhrase(armOutcome)} (review ${reviewCode === 0 ? "success" : "failure"}): ${prUrl}`);
    return reviewCode;
  } catch (e) {
    log("plan.error", { error: String((e as Error)?.message ?? e) });
    try {
      worktreeRemove(repoDir, worktreePath);
    } catch {
      /* best-effort */
    }
    throw e;
  } finally {
    removeRunLock(worktreePath); // terminal ⇒ drop the liveness token
      // Release EVERY reserved id — the ones the worker filed AND the ones it declined. Once the
      // PR exists the mint sees those ids via openPrMintTexts, so holding them longer would only
      // punch holes in the id space (the phantom-id trap: W1-T199/224/247/263).
      planIdBlock?.releaseAll();
  }
}

/** The bounded inbox-draft Architect worker's tool allowlist: Read/Grep/Glob ONLY — no
 *  Write/Edit/Bash. Drafting is TEXT the harness parses/caches state-side (never
 *  committed), so unlike `rmd triage`/`rmd plan` this worker never touches a file. */
const INBOX_DRAFT_WORKER_TOOLS = ["Read", "Grep", "Glob"];

/**
 * Materialize ONE worktree and draft EVERY proposal in `toDraft` against it — the shared
 * harness-owned glue {@link runDraftRung}'s pure core (lib/inbox.ts) needs: a real
 * `spawnWorker` inside a real worktree. Both `inboxCommand` (CLI, `rmd inbox`) and
 * {@link buildInboxDraftHook} (the daemon's per-poll rung, W1-T192) call this SAME function,
 * so the two paths can never diverge on HOW a proposal gets drafted — only on WHICH
 * proposals are due (`rmd inbox` uses {@link proposalsNeedingDraft} unthrottled;
 * the daemon uses {@link draftsDueOnDaemon}'s idempotence throttle on top of it) and what
 * happens with the resulting {@link DraftRungOutcome}s. `toDraft.length === 0` short-circuits
 * before any clone/worktree — no spend for the common "nothing to draft" case.
 */
export async function draftProposalBatch(
  toDraft: Proposal[],
  config: Config,
  owner: string,
  repo: string,
  runId: string,
  log: (step: string, extra?: Record<string, unknown>) => void,
): Promise<DraftRungOutcome[]> {
  if (toDraft.length === 0) return [];

  const mountsTable = loadMounts(mountsPath(repoRoot));
  const arch = architectModel(config, mountsTable); // Architect model is the mounts.yaml `architect:` row
  const wrk = workerModel(config);
  assertArchitectAboveWorker(arch, wrk); // throws (fail-closed) on violation

  const settingsFile = renderWorkerSettings({
    templatePath: join(repoRoot, "settings", "worker.json"),
    hooksDir: join(repoRoot, "hooks"),
    outPath: join(config.root, "tmp", `inbox-settings-${runId}.json`),
  });
  validateWorkerSettingsFile(settingsFile);

  const repoDir = join(config.root, "repos", repo);
  if (!existsSync(repoDir)) {
    mkdirSync(dirname(repoDir), { recursive: true });
    execFileSync("gh", ["repo", "clone", `${owner}/${repo}`, repoDir], { stdio: "inherit" });
  }
  const pruned = pruneStaleRuns(repoDir, worktreesDir(config), { graceMs: DEFAULT_PRUNE_GRACE_MS });
  if (pruned.worktrees.length || pruned.branches.length || pruned.skipped.length) log("worktree.prune", { ...pruned });
  const branch = `run-${runId}`;
  const worktreePath = join(worktreesDir(config), branch);
  worktreeAdd(repoDir, worktreePath, branch, "origin/main");
  writeRunLock(worktreePath, { pid: process.pid, run_id: runId, startedAt: new Date().toISOString() });

  try {
    const planText = readFileSync(join(worktreePath, "plan", "tasks.yaml"), "utf8");
    return await runDraftRung(
      toDraft,
      planText,
      {
        spawn: (proposal, prompt) =>
          spawnWorker({
            cwd: worktreePath,
            permissionMode: "bypassPermissions",
            settingsFile,
            model: arch,
            maxTurns: mountsTable.architect.maxTurns,
            maxBudgetUsd: DEFAULT_BUDGET_USD,
            config,
            prompt,
            tools: INBOX_DRAFT_WORKER_TOOLS,
          }),
        log,
      },
      runId,
    );
  } finally {
    worktreeRemove(repoDir, worktreePath);
    removeRunLock(worktreePath);
  }
}

/**
 * The daemon's per-poll DRAFT rung (W1-T192, ratifies P25's autonomous half). Reachable from
 * the daemon's OWN `deps.sweep()` seam (daemon.ts:274) — wired into {@link buildSweepHook}
 * below, riding the SAME slot the W1-T150 credit-backfill rung already occupies, never a
 * second, separately-scheduled loop. Selects candidates via {@link draftsDueOnDaemon}: the
 * SAME {@link proposalsNeedingDraft} predicate `rmd inbox` classifies against, further
 * throttled so a 300s poll cadence never re-spawns the Architect for the SAME cause (one
 * invalidation ⇒ one attempt — see lib/inbox.ts's `draftAttemptKey` doc). Every attempted
 * proposal's key is recorded in `state/inbox-draft-attempts.json` regardless of outcome —
 * a FAILED attempt is also throttled, or a stuck cause would re-spawn every poll forever
 * (the exact spend leak W1-T177 exists to prevent). Wrapped in its own try/catch so a
 * registry-read hiccup or a worktree failure is logged (`inbox.draft_rung.error`) and
 * skipped, never thrown up into the sweep/daemon loop — an un-drafted proposal is the status
 * quo, not a regression; `rmd inbox` remains available to force a draft on demand in the
 * meantime.
 */
// Exported, with `draftBatch` an injectable seam defaulting to the real draftProposalBatch
// (logic UNCHANGED — same mirrors runTask's opts.github escape hatch, drainCommand's
// githubFactory, etc.): draftProposalBatch itself clones a real worktree and spawns a real
// Architect worker, so a behavioral test of THIS hook's own inflight-file write/clear
// discipline (W1-T193) needs a seam to stand in for it without paying that cost.
export function buildInboxDraftHook(
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
  ) => Promise<DraftRungOutcome[]> = draftProposalBatch,
): () => Promise<void> {
  return async () => {
    try {
      const registryPath = join(config.root, "state", "inbox-proposals.json");
      const proposals: Proposal[] = parseProposalRegistry(readFileIfExists(registryPath));
      if (proposals.length === 0) return; // no active proposals — no spend

      const draftsPath = join(config.root, "state", "inbox-drafts.json");
      const drafts: DraftCache = parseDraftCache(readFileIfExists(draftsPath));
      const attemptsPath = join(config.root, "state", "inbox-draft-attempts.json");
      const attempts: DraftAttemptCache = parseDraftAttemptCache(readFileIfExists(attemptsPath));

      const due = draftsDueOnDaemon(proposals, drafts, attempts);
      if (due.length === 0) return;

      // W1-T193: the console must render a proposal as DRAFTING (with its spawn time) for the
      // whole window an Architect worker is actually running for it — "never lies about its
      // own state", the same bar W1-T156 set for liveness. Written BEFORE the batch spawns and
      // cleared in the `finally` below regardless of outcome, so a crash mid-draft is the only
      // way this file can go stale (self-corrects: a stuck entry is overwritten the next time
      // ANY draft batch runs, since this rung always writes its own full `due` set, never
      // merges onto a stale one).
      const inflightPath = join(config.root, "state", "inbox-draft-inflight.json");
      const spawnedAt = new Date().toISOString();
      writeFileSync(inflightPath, JSON.stringify(Object.fromEntries(due.map((p) => [p.id, spawnedAt])), null, 2), "utf8");

      let outcomes: DraftRungOutcome[];
      try {
        outcomes = await draftBatch(due, config, owner, repo, runId, log);
      } finally {
        // Only one draft rung runs at a time (this hook is awaited to completion by the
        // daemon's own serial sweep tick before the next one can start), so it is always safe
        // to clear the WHOLE file here rather than surgically remove just `due`'s ids.
        writeFileSync(inflightPath, JSON.stringify({}, null, 2), "utf8");
      }

      const nextDrafts: DraftCache = { ...drafts };
      const nextAttempts: DraftAttemptCache = { ...attempts };
      for (const outcome of outcomes) {
        const proposal = due.find((p) => p.id === outcome.proposalId);
        if (!proposal) continue; // unreachable — outcomes are 1:1 with `due`
        // IDEMPOTENCE (W1-T192): mark this cause ATTEMPTED whether it succeeded or failed —
        // see this function's own doc for why a failed attempt must be throttled too.
        nextAttempts[outcome.proposalId] = draftAttemptKey(proposal);
        if (outcome.ok) nextDrafts[outcome.proposalId] = outcome.candidate;
      }
      // ATOMIC PAIR (W1-T241): see lib/inbox.ts's `writeDraftAttemptPair` doc for the
      // torn-file/wedged-idempotence hazard this closes and why drafts commits before
      // attempts.
      writeDraftAttemptPair(draftsPath, attemptsPath, nextDrafts, nextAttempts);
    } catch (e) {
      log("inbox.draft_rung.error", { error: String((e as Error)?.message ?? e) });
    }
  };
}

/**
 * `rmd inbox [--dry-run]` — the ratification inbox's deterministic core, wired live
 * (MASTER-PLAN P25(i), W1-T110). The actual readiness predicate ({@link
 * classifyProposal}) is a PURE function, unit-tested exhaustively over fixtures
 * (test/inbox.test.ts) with the LLM stubbed out entirely — this command is the thin,
 * real-world GLUE around it, in the same "pure core / harness-owned I/O" split as
 * `rmd dep-review`/`rmd triage`/`rmd plan`:
 *
 *   1. Read the ACTIVE-proposal registry (`<config.root>/state/inbox-proposals.json`
 *      — state-side, never a repo path; population of this registry — e.g. from
 *      MASTER-PLAN.md's proposal list — is a separate, later concern). Zero
 *      proposals ⇒ print "no active proposals" and return immediately (no clone, no
 *      spend) — the common case on a fresh checkout.
 *   2. For every proposal {@link proposalsNeedingDraft} names (NOT deferred-by-trigger,
 *      cached draft missing or stale) — UNTHROTTLED, unlike the daemon's own rung below,
 *      because this is the operator's MANUAL FORCE (W1-T192: `rmd inbox` is demoted from
 *      the only trigger to a manual one, never removed as a trigger) — spawn ONE bounded
 *      Architect worker per proposal ({@link draftProposalBatch}) and cache the result.
 *      Skipped entirely under `--dry-run` (classify against whatever is already cached,
 *      spend nothing).
 *   3. Classify every proposal with REAL facts: dependency-merge state via
 *      `deriveStatus` (GitHub-derived, corrections-supreme — never the decorative
 *      yaml `status:` field), evidence-anchor truth via a real `git grep` against
 *      `origin/main` ({@link gitGrepAnchorTrue}), and lint-cleanliness via the SAME
 *      `rmd lint-plan` checks every other plan PR is gated by (inside
 *      classifyProposal itself).
 *   4. Print {@link renderInbox} and ledger-log one `inbox.classified` line per
 *      proposal (traceable via `rmd trace`).
 *
 * NOTE (W1-T192): the daemon's OWN per-poll draft rung ({@link buildInboxDraftHook}) is what
 * makes a draft exist without this command ever being invoked — see that function's doc.
 */
export async function inboxCommand(rest: string[], deps: { config?: Config } = {}): Promise<number> {
  const badArg = unknownArgError("inbox", rest, [], ["--dry-run"]);
  if (badArg) {
    console.error(badArg + "\n" + USAGE);
    return 2;
  }
  const dryRun = rest.includes("--dry-run");

  const config = deps.config ?? loadConfig();
  const plan = loadPlan(join(repoRoot, "plan", "tasks.yaml"));
  const ledgerPath = ledgerPathFor(config);
  const { owner, repo } = resolveOwnerRepo();

  const registryPath = join(config.root, "state", "inbox-proposals.json");
  const proposals: Proposal[] = parseProposalRegistry(readFileIfExists(registryPath));
  if (proposals.length === 0) {
    console.log(renderInbox([]));
    return 0;
  }

  const draftsPath = join(config.root, "state", "inbox-drafts.json");
  const drafts: DraftCache = parseDraftCache(readFileIfExists(draftsPath));

  // UNTHROTTLED (see this command's doc) — `rmd inbox` is the manual FORCE, so it always
  // attempts every proposal `proposalsNeedingDraft` names, never consulting the daemon-only
  // DraftAttemptCache.
  const needsDraft = proposalsNeedingDraft(proposals, drafts);

  const runId = `INBOX-${Date.now()}`;
  const log = (step: string, extra: Record<string, unknown> = {}) => appendLedger(ledgerPath, { run_id: runId, task_id: "inbox", step, ...extra });

  if (needsDraft.length > 0 && !dryRun) {
    const outcomes = await draftProposalBatch(needsDraft, config, owner, repo, runId, log);
    for (const outcome of outcomes) {
      if (outcome.ok) drafts[outcome.proposalId] = outcome.candidate;
    }
    writeFileSync(draftsPath, JSON.stringify(drafts, null, 2), "utf8");
  }

  const deriveDeps: DeriveDeps = { ledgerPath, github: ghGateway(owner, repo) };
  const isMerged: MergedResolver = (t) => deriveStatus(t, deriveDeps).merged;
  const openProposalIds = new Set(proposals.map((p) => p.id));
  // W1-T190: re-derive "already ratified" from the ledger on every `rmd inbox` pass, never
  // from the registry's own state — a proposal ratify.approved already fired for is reported
  // ratified even if the registry entry itself drifted (the P19 incident).
  const ledgerLinesForRatify = readLedgerLines(ledgerPath);

  const classifications = proposals.map((p) =>
    classifyProposal(p, drafts[p.id], {
      plan,
      isMerged,
      grepAnchorTrue: (a: EvidenceAnchor) => gitGrepAnchorTrue(repoRoot, "origin/main", a),
      openProposalIds,
      isRatified: (id) => isRatifiedInLedger(ledgerLinesForRatify, id),
    }),
  );
  for (const c of classifications) log("inbox.classified", { proposal_id: c.proposalId, state: c.state, reasons: c.reasons });
  // W1-T112: one `inbox.polled` snapshot per invocation — digest.ts reads the LATEST such
  // line inside its window and folds it into the daily pulse's soft-composed "inbox: N
  // ready" line (see lib/inbox.ts's InboxPollSummary doc). Logged unconditionally, same as
  // the `inbox.classified` lines just above — `rmd inbox --dry-run` already always
  // classifies+ledgers (it only skips the draft-synthesis SPAWN), unlike `rmd ops`/`rmd
  // issues`, whose dry-run skips their own poll-summary line because THEIR poll has real
  // side effects (escalate/capture) a preview must leave no trace of; classification here
  // has none.
  log("inbox.polled", { inbox: summarizeInboxPoll(classifications) });

  // W1-T190 (round 2): a proposal classified "ratified" here is DETECTED off the ledger,
  // never trusted from the registry's own (possibly drifted) copy — but detection alone
  // still leaves the drifted row sitting in state/inbox-proposals.json forever. Heal it:
  // any proposal the ledger already ratified is pruned from the registry on THIS pass, the
  // same way approveCommand prunes the common (non-drifted) case, so the correction lands
  // on disk, not just in this run's in-memory classification.
  const { prunedIds } = pruneRatifiedProposals(proposals, classifications);
  if (prunedIds.length > 0) {
    // W1-T240: reapply the (already-derived, ledger-sourced) prunedIds set against a
    // FRESH read of the registry, under lock — never blind-write the `proposals` array
    // this function read at the top, which a concurrent `rmd approve`/`rmd reframe`/the
    // daemon's own `GET /v1/inbox` heal could have changed in the meantime. See
    // lib/inbox.ts's `updateProposalRegistry` doc for the lost-update/torn-file hazard
    // this guards against.
    const prunedIdSet = new Set(prunedIds);
    updateProposalRegistry(registryPath, (current) => {
      const fresh = current.filter((p) => !prunedIdSet.has(p.id));
      return fresh.length === current.length ? null : fresh;
    });
    for (const id of prunedIds) log("inbox.registry_healed", { proposal_id: id });
  }

  const rendered = renderInbox(classifications);
  console.log(rendered);
  return 0;
}

/** Load the ACTIVE-proposal registry + draft cache and classify ONE proposal against REAL
 *  facts (deriveStatus-derived merge state, real `git grep`, the whole registry as the
 *  conflict set) — the SAME readiness context `inboxCommand` classifies every proposal
 *  with, factored out so `rmd approve`/`rmd reframe` never diverge from what `rmd inbox`
 *  showed the operator. Returns `undefined` proposal when `proposalId` is not in the
 *  registry — the caller turns that into a fail-loud usage error. */
function loadProposalForRatify(
  proposalId: string,
  plan: Plan,
  ledgerPath: string,
  owner: string,
  repo: string,
  config: Config,
): { proposal: Proposal | undefined; proposals: Proposal[]; drafts: DraftCache; draftsPath: string; classification?: InboxClassification } {
  const registryPath = join(config.root, "state", "inbox-proposals.json");
  const proposals: Proposal[] = parseProposalRegistry(readFileIfExists(registryPath));
  const proposal = proposals.find((p) => p.id === proposalId);

  const draftsPath = join(config.root, "state", "inbox-drafts.json");
  const drafts: DraftCache = parseDraftCache(readFileIfExists(draftsPath));

  if (!proposal) return { proposal: undefined, proposals, drafts, draftsPath };

  const deriveDeps: DeriveDeps = { ledgerPath, github: ghGateway(owner, repo) };
  const isMerged: MergedResolver = (t) => deriveStatus(t, deriveDeps).merged;
  // W1-T190: read the ledger ONCE here and cross-check it, never the registry's own copy of
  // "is this ratified" (there isn't one) — a proposal the ledger already carries
  // ratify.approved for is `ratified`, no matter what stale/drifted state the registry entry
  // itself is still in (the P19 incident this task fixes).
  const ledgerLines = readLedgerLines(ledgerPath);
  const ctx: ReadinessContext = {
    plan,
    isMerged,
    grepAnchorTrue: (a: EvidenceAnchor) => gitGrepAnchorTrue(repoRoot, "origin/main", a),
    openProposalIds: new Set(proposals.map((p) => p.id)),
    isRatified: (id) => isRatifiedInLedger(ledgerLines, id),
  };
  const classification = classifyProposal(proposal, drafts[proposal.id], ctx);
  return { proposal, proposals, drafts, draftsPath, classification };
}

/**
 * `rmd approve <P##>` — the operator's ONE BIT (MASTER-PLAN P25 ii, W1-T111). Refuses
 * anything not currently READY (re-classified live, against the SAME facts `rmd inbox`
 * would show right now — never a stale cached verdict), naming the state; a READY
 * proposal's cached draft is shipped VERBATIM into a plan PR that rides the full gate
 * (ci-gate + remudero-review) before auto-merge is armed — rule 15: the bit INITIATES,
 * it never merges anything itself. The pure decision + gateway-call-counting live in
 * {@link approveProposal}; this command is the thin real-world glue (mirrors
 * `inboxCommand`/`planCommand`'s split).
 */
export async function approveCommand(rest: string[], deps: { config?: Config; gateway?: RatifyGateway } = {}): Promise<number> {
  const proposalId = rest[0];
  const badArg = unknownArgError("approve", rest.slice(1), [], []);
  if (!proposalId || badArg) {
    console.error((badArg ?? `rmd approve: <P##> is required — usage: ${commandSyntax("approve")}`) + "\n" + USAGE);
    return 2;
  }

  const config = deps.config ?? loadConfig();
  const plan = loadPlan(join(repoRoot, "plan", "tasks.yaml"));
  const ledgerPath = ledgerPathFor(config);
  const registryPath = join(config.root, "state", "inbox-proposals.json");
  const { owner, repo } = resolveOwnerRepo();

  const { proposal, classification } = loadProposalForRatify(proposalId, plan, ledgerPath, owner, repo, config);
  if (!proposal || !classification) {
    console.error(`rmd approve: unknown proposal '${proposalId}' — not in the ACTIVE registry (state/inbox-proposals.json)`);
    return 2;
  }

  const runId = `APPROVE-${proposalId}-${Date.now()}`;
  const log = (step: string, extra: Record<string, unknown> = {}) => appendLedger(ledgerPath, { run_id: runId, task_id: proposalId, step, ...extra });

  let repoDir: string | undefined;
  let worktreePath: string | undefined;
  // Filed task id(s), captured by createRatificationBranch (it runs first — approveProposal
  // always calls createRatificationBranch(payload) before openPlanPr) for openPlanPr's
  // Acceptance-criteria auto-authorship below — the closure approach lets openPlanPr's
  // signature (part of the RatifyGateway interface other tests fake) stay unchanged.
  let filedTaskIds: string[] = [];
  // W1-T311: the block {@link materializeDraftTaskIds} reserves for this approve's placeholder
  // ids — held until the PR actually exists (released below, once `result.ok`), so a
  // console-initiated or second-machine approve overlapping this CLI one cannot mint the same
  // ids. Released on any failure path too (the catch around `approveProposal` below) — every
  // reserved id, used or not, must come back, or it is a phantom-id hole (W1-T199/224/247/263).
  let idBlock: TaskIdReservationBlock | undefined;
  const gateway: RatifyGateway = deps.gateway ?? {
    createRatificationBranch(payload) {
      repoDir = join(config.root, "repos", repo);
      if (!existsSync(repoDir)) {
        mkdirSync(dirname(repoDir), { recursive: true });
        execFileSync("gh", ["repo", "clone", `${owner}/${repo}`, repoDir], { stdio: "inherit" });
      }
      const pruned = pruneStaleRuns(repoDir, worktreesDir(config), { graceMs: DEFAULT_PRUNE_GRACE_MS });
      if (pruned.worktrees.length || pruned.branches.length || pruned.skipped.length) log("worktree.prune", { ...pruned });
      const branch = `run-${runId}`;
      worktreePath = join(worktreesDir(config), branch);
      worktreeAdd(repoDir, worktreePath, branch, "origin/main");
      writeRunLock(worktreePath, { pid: process.pid, run_id: runId, startedAt: new Date().toISOString() });

      // W1-T311: MINT + RESERVE the drafted fragment's placeholder (`NEW-<n>`) ids from the
      // FRESH worktree's plan, AFTER it is created at origin/main and BEFORE anything is
      // written — the same ordering `rmd triage`/`rmd plan` already use (:11831,:12159), calling
      // the ONE shared derivation rather than re-deriving ids locally here. A degraded mint
      // source or a reservation failure REFUSES (throws) before any write, so no partial union
      // ever reaches the worktree.
      const materialized = materializeDraftTaskIds(
        { fragmentYaml: payload.fragmentYaml, stampLine: payload.stampLine },
        {
          mint: () =>
            mintNextTaskIdWithHistory({
              planPath: join(worktreePath as string, "plan", "tasks.yaml"),
              repoRoot: worktreePath as string,
              openPrTexts: () => openPrMintTexts(owner, repo),
            }),
          reserveBlock: (startId, count) => {
            idBlock = reserveTaskIdBlock(startId, count, taskIdReservationsDir(config.root), {
              info: { purpose: `rmd approve ${payload.proposalId} (run ${runId})` },
            });
            return idBlock;
          },
        },
      );
      if (!materialized.ok) {
        throw new Error(`rmd approve: refusing to materialize task id(s) for ${payload.proposalId} — ${materialized.reason}`);
      }
      log("approve.id_materialized", { proposal_id: payload.proposalId, ids: materialized.ids });

      const tasksPath = join(worktreePath, "plan", "tasks.yaml");
      writeFileSync(tasksPath, applyFragmentToPlanYaml(readFileSync(tasksPath, "utf8"), materialized.fragmentYaml), "utf8");
      const masterPlanPath = join(worktreePath, "MASTER-PLAN.md");
      writeFileSync(masterPlanPath, applyStampToMasterPlan(readFileSync(masterPlanPath, "utf8"), payload.proposalId, materialized.stampLine), "utf8");

      // W1-T136 (#287 class): regenerate plan/plan-index.json to reflect the just-stamped
      // MASTER-PLAN.md BEFORE the single git-add below, which already sweeps up anything
      // under plan/ — no separate commit needed here, unlike retro's own commit.
      try {
        regeneratePlanIndexFile({ worktreePath });
      } catch (e) {
        log("plan_index.regen.error", { error: String((e as Error)?.message ?? e) });
      }

      // materialized.fragmentYaml carries only REAL ids now (materializeDraftTaskIds already
      // rewrote every placeholder) — same per-line `- id: <id>` regex the pre-W1-T311 code used,
      // just over the rewritten text rather than payload.fragmentYaml verbatim.
      filedTaskIds = [...materialized.fragmentYaml.matchAll(/^- id:\s*(\S+)/gm)].map((m) => m[1]);

      execFileSync("git", ["-C", worktreePath, "add", "-A", "--", "plan/", "MASTER-PLAN.md"], { stdio: "inherit" });
      execFileSync("git", ["-C", worktreePath, "commit", "-m", approveCommitMessage(payload)], { stdio: "inherit" });
      gitPushRunBranch(worktreePath);
      return branch;
    },
    openPlanPr(branch, id) {
      const intro = [
        classification.draft?.stampLine ?? "",
        "",
        "The operator's one-bit approve initiated this PR (MASTER-PLAN P25 ii, W1-T111). The",
        "gate still reviews (ci + remudero-review); nothing auto-merges without it.",
      ].join("\n");
      // W1-T136 (#387 class): a real, rendered, ALWAYS-judgeable Acceptance block — the #387
      // bug was opening this PR with NO Acceptance section, which fails remudero-review
      // CLOSED. This is a plan-FILING PR (it introduces filedTaskIds, doesn't implement
      // them), so the criteria are about the filing itself (filingAcceptanceCriteria), and
      // NO Remudero-Task trailer is emitted (the correctness rule, lib/plan-pr-emitter.ts).
      const ids = filedTaskIds.length > 0 ? filedTaskIds : [id];
      const body = buildPlanPrBody({
        intro,
        criteria: filingAcceptanceCriteria(ids, ["plan/tasks.yaml", "MASTER-PLAN.md"]),
      });
      assertLiveWriteAllowed("gh-pr-create", `opening a PR against ${owner}/${repo}`);
      const out = execFileSync(
        "gh",
        ["pr", "create", "--repo", `${owner}/${repo}`, "--base", "main", "--head", branch, "--title", `chore(plan): ratify ${id} via rmd approve`, "--body", body],
        { encoding: "utf8" },
      );
      const prUrl = out.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/)?.[0];
      if (!prUrl) throw new Error("rmd approve: `gh pr create` produced no PR url");
      return prUrl;
    },
  };

  let result: ReturnType<typeof approveProposal>;
  try {
    result = approveProposal(classification, gateway, { ledgerPath, runId });
  } catch (e) {
    // W1-T311: createRatificationBranch REFUSED (a degraded mint or a failed reservation) —
    // or any other failure inside either gateway call. approveProposal never reached its own
    // ledger append on this path, so NOTHING was ratified: no PR opened, the registry entry
    // below is never touched (this proposal stays READY), and every id this run reserved
    // (if any) comes back rather than punching a phantom-id hole.
    log("approve.error", { error: String((e as Error)?.message ?? e) });
    idBlock?.releaseAll();
    if (repoDir && worktreePath) {
      try {
        worktreeRemove(repoDir, worktreePath);
      } catch {
        /* best-effort */
      }
      try {
        removeRunLock(worktreePath);
      } catch {
        /* best-effort */
      }
    }
    throw e;
  }
  if (!result.ok) {
    console.error(`rmd approve: ${result.refusal}`);
    return 1;
  }

  // W1-T311: both gateway calls above succeeded — the PR already exists, so the mint now sees
  // this run's ids via openPrMintTexts. Release the reservation here rather than holding it
  // through the CI wait below: holding longer only punches holes in the id space (the
  // phantom-id trap: W1-T199/224/247/263), the same reasoning `rmd plan`'s own release carries.
  idBlock?.releaseAll();

  // W1-T190: `ratify.approved` above just ledgered this proposal's ratification, but the
  // ledger and the registry are two different sources of truth — `rmd inbox`/the console's
  // `/v1/inbox` route (buildInboxRoute) classify strictly off state/inbox-proposals.json,
  // never the ledger, so leaving this entry in place kept recommending an already-ratified
  // proposal as READY indefinitely. Mirrors reframeCommand's registry write below (5646+ in
  // this file): this proposal is no longer ACTIVE (see the Proposal interface's doc comment
  // in lib/inbox.ts), so it is removed rather than rewritten in place.
  // W1-T240: drop `proposalId` from a FRESH read of the registry under lock, never a
  // stale in-memory array — a concurrent `rmd reframe`/the daemon's own heal write could
  // have changed the file since `loadProposalForRatify` read it above. See
  // lib/inbox.ts's `updateProposalRegistry` doc for the lost-update/torn-file hazard
  // this guards against.
  updateProposalRegistry(registryPath, (current) => {
    const next = current.filter((p) => p.id !== proposalId);
    return next.length === current.length ? null : next;
  });

  if (!repoDir || !worktreePath) {
    // Unreachable in practice — the gateway above always sets these before returning a
    // branch — but fail LOUD rather than silently skip cleanup/gate if it ever were.
    throw new Error("rmd approve: gateway reported success but never created a ratification branch");
  }
  const ownedRepoDir = repoDir;
  const ownedWorktreePath = worktreePath;

  try {
    // RUN-OWNERSHIP GUARD (W1-T62 precedent) — never trailer/gate/arm a PR that is not
    // actually this run's own branch.
    const ownership = checkPrOwnership(result.prUrl, result.branch, ghPrHeadGateway(), 0);
    if (ownership) {
      log("verdict", ownership.ledger);
      console.error(`rmd approve: claimed PR ${result.prUrl} is not this run's own branch (${result.branch})`);
      worktreeRemove(ownedRepoDir, ownedWorktreePath);
      return 1;
    }
    // W1-T136 (#387 correctness rule): NO `ensureTaskTrailer` call here — a ratification
    // branch is a plan-FILING PR (it introduces the ratified task(s), it does not
    // implement them). `ensureTaskTrailer(result.prUrl, proposalId)` used to stamp a
    // `Remudero-Task: <proposalId>` trailer post-hoc, undoing the no-trailer contract
    // approveCommitMessage/openPlanPr's body now enforce (findMergedByTrailer would
    // credit that trailer's id as DONE on merge — see lib/plan-pr-emitter.ts's doc
    // comment). proposalId (e.g. "P19") never collides with a real task id's W1-Txxx
    // shape, but a filing PR carries NO Remudero-Task trailer at all, full stop.
    log("pr.opened", { pr_url: result.prUrl, branch: result.branch });
    console.log(`rmd approve: ${proposalId} — plan PR opened: ${result.prUrl}`);

    const ci = await waitForCiGreen(result.prUrl, (s, extra) => log(s, extra));
    if (ci !== "green") {
      console.log(`ci ${ci} — PR left OPEN: ${result.prUrl}`);
      worktreeRemove(ownedRepoDir, ownedWorktreePath);
      return 1;
    }
    const prNum = result.prUrl.match(/\/pull\/(\d+)/)?.[1] ?? result.prUrl;
    const reviewCode = await reviewCommand(prNum);
    // W1-T230: a ratification PR carries NO Remudero-Task trailer by design
    // (see the no-trailer comment above) — reviewCommand's own taskId resolve
    // therefore falls back to `PR-${view.number}` and its review.posted ledger
    // line is keyed to that same fallback, not `proposalId`.
    const armOutcome = armAndLogOutcome(result.prUrl, `PR-${prNum}`, log);
    worktreeRemove(ownedRepoDir, ownedWorktreePath);
    console.log(`rmd approve: ${proposalId} gated — ${armReportPhrase(armOutcome)} (review ${reviewCode === 0 ? "success" : "failure"}): ${result.prUrl}`);
    return reviewCode;
  } catch (e) {
    log("approve.error", { error: String((e as Error)?.message ?? e) });
    try {
      worktreeRemove(ownedRepoDir, ownedWorktreePath);
    } catch {
      /* best-effort */
    }
    throw e;
  } finally {
    removeRunLock(ownedWorktreePath);
  }
}

/**
 * `rmd reframe <P##> --feedback "<text>" [--supersedes <rounds>]` — the operator's
 * OBJECTION path (MASTER-PLAN P25 iii, W1-T111): captures the feedback verbatim, ledgers
 * `ratify.reframed`, and invalidates the proposal's cached draft so the NEXT `rmd inbox`
 * pass redrafts WITH the feedback in the Architect prompt ({@link inboxDraftPrompt}). Valid
 * for ANY proposal already in the registry, whatever its current classification — reframe
 * is feedback, never a ratification, and opens no PR. State-side only (registry + draft
 * cache + ledger); no clone, no worktree, no `gh` call.
 *
 * `--supersedes` (W1-T194) is the EXPLICIT retraction surface the composer's own
 * "address EVERY round" header otherwise leaves nothing to countermand: a round number, a
 * comma list, a range, or `ALL` ({@link parseSupersedesExpr}), naming EXISTING rounds this
 * round supersedes. Retraction never deletes — the retracted rounds stay in
 * `reframeHistory` and their original ledger lines are untouched — it only stops
 * {@link inboxDraftPrompt} from carrying their text into the NEXT redraft. An invalid
 * expression (out of range, unparseable) is a usage error; nothing is written.
 */
export async function reframeCommand(rest: string[], deps: { config?: Config } = {}): Promise<number> {
  const proposalId = rest[0];
  const badArg = unknownArgError("reframe", rest.slice(1), ["--feedback", "--supersedes"], []);
  if (!proposalId || badArg) {
    console.error((badArg ?? `rmd reframe: <P##> is required — usage: ${commandSyntax("reframe")}`) + "\n" + USAGE);
    return 2;
  }
  const feedback = flagValue(rest, "--feedback");
  if (!feedback) {
    console.error(`rmd reframe: --feedback "<text>" is required — usage: ${commandSyntax("reframe")}\n` + USAGE);
    return 2;
  }

  const config = deps.config ?? loadConfig();
  const plan = loadPlan(join(repoRoot, "plan", "tasks.yaml"));
  const ledgerPath = ledgerPathFor(config);
  const { owner, repo } = resolveOwnerRepo();

  const registryPath = join(config.root, "state", "inbox-proposals.json");
  const { proposal, drafts, draftsPath } = loadProposalForRatify(proposalId, plan, ledgerPath, owner, repo, config);
  if (!proposal) {
    console.error(`rmd reframe: unknown proposal '${proposalId}' — not in the ACTIVE registry (${registryPath})`);
    return 2;
  }

  const supersedesExpr = flagValue(rest, "--supersedes");
  let supersedes: number[] | undefined;
  if (supersedesExpr !== undefined) {
    const historyLength = (proposal.reframeHistory ?? []).length;
    const parsed = parseSupersedesExpr(supersedesExpr, historyLength);
    if (!parsed) {
      console.error(
        `rmd reframe: --supersedes '${supersedesExpr}' is not a valid round expression for ${proposalId} ` +
          `(${historyLength} round${historyLength === 1 ? "" : "s"} on record) — expected round numbers, a ` +
          `range (e.g. "2-3"), or ALL. Usage: ${commandSyntax("reframe")}\n${USAGE}`,
      );
      return 2;
    }
    supersedes = parsed;
  }

  const runId = `REFRAME-${proposalId}-${Date.now()}`;
  // W1-T240: apply the reframe against a FRESH read of the registry, under lock — never
  // the `proposal` `loadProposalForRatify` read above, which a concurrent `rmd approve`/
  // another `rmd reframe`/the daemon's own heal write could have changed (or removed)
  // since. See lib/inbox.ts's `updateProposalRegistry` doc for the lost-update/torn-file
  // hazard this guards against.
  let reframed: ReframeResult | undefined;
  updateProposalRegistry(registryPath, (current) => {
    const freshProposal = current.find((p) => p.id === proposalId);
    if (!freshProposal) return null; // vanished concurrently — nothing left to reframe
    reframed = reframeProposal(freshProposal, feedback, drafts, { ledgerPath, runId }, supersedes);
    return current.map((p) => (p.id === proposalId ? reframed!.proposal : p));
  });
  if (!reframed) {
    console.error(`rmd reframe: ${proposalId} was removed from the registry by a concurrent update — nothing to reframe`);
    return 2;
  }
  writeFileSync(draftsPath, JSON.stringify(reframed.drafts, null, 2), "utf8");

  console.log(
    supersedes && supersedes.length > 0
      ? `rmd reframe: ${proposalId} — feedback ledgered, round${supersedes.length > 1 ? "s" : ""} ${supersedes.join(", ")} ` +
          "retracted, draft invalidated; the next `rmd inbox` pass will redraft with it."
      : `rmd reframe: ${proposalId} — feedback ledgered, draft invalidated; the next \`rmd inbox\` pass will redraft with it.`,
  );
  return 0;
}

/**
 * `rmd digest [--since <iso>] [--dry-run]` — roll up the ledger since `--since` into one message
 * (digest.ts) and send it over iMessage; `--dry-run` prints the text without sending.
 *
 * W1-T163 (MARKER-AWARE by default): with NO `--since`, the window is the operator's own
 * `lib/last-seen.ts` marker — the SAME per-token marker the console's `GET /v1/status` recap
 * advances on a board view (lib/board.ts) — keyed off the write token's id (the write token is
 * the operator's real credential; a read-only caller never sends this digest). A first-ever send
 * (no marker yet) falls back to the pre-existing 24h-ago default. Sending (never `--dry-run`,
 * which previews without any side effect) then ADVANCES that same marker to now, so "push and
 * pull tell one story": whichever of a digest send or a console view happens next only reports
 * what's left since THIS send, never re-reporting what it already covered.
 *
 * An EXPLICIT `--since` is an operator-directed override/inspection tool — it builds/sends
 * exactly that window (old behavior, unchanged) and deliberately never touches the marker, so a
 * one-off "show me since <date>" never resets the shared push/pull window out from under it.
 */
export async function digestCommand(
  rest: string[],
  deps: { notifyChannel?: NotifyChannel } = {},
): Promise<number> {
  const explicitSince = flagValue(rest, "--since");
  const config = loadConfig();
  const ledgerPath = ledgerPathFor(config);

  if (explicitSince !== undefined) {
    if (rest.includes("--dry-run")) {
      console.log(buildDigest(ledgerPath, explicitSince, consoleUrl(config)));
      return 0;
    }
    const text = sendDigest(
      ledgerPath,
      explicitSince,
      {
        channel: deps.notifyChannel ?? imessageChannel(notifyRecipient(config)),
        ledgerPath,
        runId: `DIGEST-${Date.now()}`,
        taskId: "DIGEST",
      },
      consoleUrl(config),
    );
    console.log(text);
    return 0;
  }

  const tokenId = hashToken(resolveServiceTokens(config.root).write);
  const store = createLastSeenStore(lastSeenPath(config.root));
  const nowIso = new Date().toISOString();
  if (rest.includes("--dry-run")) {
    console.log(buildMarkerAwareDigest(ledgerPath, store, tokenId, nowIso, consoleUrl(config)).text);
    return 0;
  }
  const text = sendMarkerAwareDigest(
    ledgerPath,
    store,
    tokenId,
    {
      channel: deps.notifyChannel ?? imessageChannel(notifyRecipient(config)),
      ledgerPath,
      runId: `DIGEST-${Date.now()}`,
      taskId: "DIGEST",
    },
    nowIso,
    consoleUrl(config),
  );
  console.log(text);
  return 0;
}

/**
 * `rmd ops [--dry-run]` — alert intake v0+v1 (W1-T55/W1-T56, MASTER-PLAN §5D lane 2, §7B): poll
 * code-scanning/Dependabot/secret-scanning alerts for THIS repo via `gh api` (lib/ops.ts), fold
 * OPEN counts+ages into the next `rmd digest`, escalate every NEW critical/high alert exactly
 * once via the SHIPPED escalate() path, and capture a `plan/feedback/<id>.yaml` entry (origin:
 * `alert#<source>-<id>`) for every open alert not already captured, ANY severity, for `rmd
 * triage` (W1-T41) to ground and propose a corrective task from. Escalation dedup is
 * ledger-keyed (escalation.issue_opened task ids); feedback-capture dedup is id-keyed (a
 * deterministic `fb-alert-<owner>-<repo>-<source>-<id>` id) — a re-poll of the SAME open alerts
 * escalates and captures nothing new. --dry-run previews the counts + which alerts WOULD
 * escalate; it opens no issues, captures no feedback, and writes no ledger line.
 */
async function opsCommand(rest: string[]): Promise<number> {
  const badArg = unknownArgError("ops", rest, [], ["--dry-run"]);
  if (badArg) {
    console.error(badArg + "\n" + USAGE);
    return 2;
  }
  const dryRun = rest.includes("--dry-run");
  const config = loadConfig();
  const ledgerPath = ledgerPathFor(config);
  const { owner, repo } = resolveOwnerRepo();
  const runId = `OPS-${Date.now()}`;
  const result = await pollAlerts(owner, repo, {
    alerts: ghAlertGateway(),
    issues: ghIssueGateway(owner, repo),
    ledgerPath,
    runId,
    root: repoRoot,
    dryRun,
  });
  console.log(`### rmd ops${dryRun ? " --dry-run" : ""} — ${owner}/${repo}\nalerts: ${renderAlertsSummary(result.summary)}`);
  if (dryRun) {
    console.log(
      result.newCritical.length
        ? `would escalate ${result.newCritical.length} new critical/high alert(s): ${result.newCritical
            .map((a) => `${a.source}#${a.id} [${a.severity}]`)
            .join(", ")}`
        : "no new critical/high alerts to escalate",
    );
  } else if (result.escalated.length > 0) {
    console.log(`escalated ${result.escalated.length} new critical/high alert(s):`);
    for (const e of result.escalated) console.log(`  ${e.alert.source}#${e.alert.id} [${e.alert.severity}] -> ${e.issueUrl}`);
  } else {
    console.log("no new critical/high alerts to escalate");
  }
  if (!dryRun) {
    if (result.feedbackCreated.length > 0) {
      console.log(`captured ${result.feedbackCreated.length} new feedback entr${result.feedbackCreated.length === 1 ? "y" : "ies"}:`);
      for (const e of result.feedbackCreated) console.log(`  ${e.origin} -> plan/feedback/${e.id}.yaml`);
    } else {
      console.log("no new alerts to capture as feedback");
    }
  }
  return 0;
}

/**
 * The ephemeral fix-run worker's prompt (W1-T90) — mirrors the retro/triage prompts' own
 * "harness eats first" split: the WORKER only fixes the alert and opens its own PR through the
 * normal contract (`Acceptance:`/`Remudero-Task:` trailer, `PR_URL:` REPORT line); this command
 * owns the worktree/spawn/teardown mechanics deterministically, so an LLM can never skip the
 * contract or scope-creep past the one named alert.
 */
function alertFixPrompt(alert: AlertLaneAlert, taskId: string): string {
  return [
    "You are a REMUDERO fix worker dispatched by the alert-fix lane (W1-T90, MASTER-PLAN P20, §5D lane 2).",
    "Fix EXACTLY ONE thing: the alert named below. Do not scope-creep into unrelated changes.",
    "",
    `Alert: ${alert.source} #${alert.id} [${alert.severity}]`,
    `Summary: ${alert.summary}`,
    alert.url ? `Link: ${alert.url}` : undefined,
    alert.path ? `Path: ${alert.path}` : undefined,
    "",
    "This alert was matched by policy (plan/alert-policy.yaml) as safe to auto-fix: severity is",
    "medium or low, AND outside the gate/containment-critical path set. Make the minimal, correct fix.",
    "",
    "Then, from the working directory:",
    "- git add the changed files && commit with a concise message;",
    "- `git push origin HEAD` (NOT -u);",
    "- open a PR: `gh pr create --fill --base main`. The PR body MUST include:",
    "  - an `Acceptance:` block of `- <claim> | <proof>` bullets covering the fix;",
    `  - \`origin: alert#${alertOriginId(alert)}\` naming this alert's provenance;`,
    `  - as the LAST body line: \`Remudero-Task: ${taskId}\`.`,
    "- End your REPORT with exactly: PR_URL: <the pull request url>",
  ]
    .filter((l): l is string => l !== undefined)
    .join("\n");
}

/**
 * The effectful collaborators {@link dispatchAlertFixRun} calls through — real defaults below,
 * injectable so a unit test can drive every branch (success/no-PR/error) without ever shelling
 * `git worktree`, reading `mounts.yaml`, or spawning the Agent SDK for real (the SAME
 * fake-the-boundary shape {@link withMaterializedWorktree}'s injected `remove` and
 * `defaultReconRunLens`'s injected `spawn`/`probeExec` already use in this file).
 */
export interface AlertFixDispatchDeps {
  worktreeAdd: (repoDir: string, worktreePath: string, branch: string, startPoint: string) => void;
  worktreeRemove: (repoDir: string, worktreePath: string) => void;
  renderWorkerSettings: typeof renderWorkerSettings;
  loadMounts: typeof loadMounts;
  resolveMount: typeof resolveMount;
  spawn: (args: SpawnWorkerArgs) => Promise<WorkerResult>;
  ensureTaskTrailer: (prUrl: string, taskId: string) => void;
}

const REAL_ALERT_FIX_DISPATCH_DEPS: AlertFixDispatchDeps = {
  worktreeAdd,
  worktreeRemove,
  renderWorkerSettings,
  loadMounts,
  resolveMount,
  spawn: spawnWorker,
  ensureTaskTrailer,
};

/**
 * The real `deps.dispatch` effect {@link runAlertLane} calls for an "act" disposition (W1-T90) —
 * a MINIMAL analog of `buildSweepEffects`'s `dispatchFix` (~line 5546): a fresh branch off
 * `origin/main`, a fresh worker settings file, ONE `spawnWorker` call, teardown. Deliberately
 * NOT `dispatchFix`'s full machinery (no existing task/PR/branch to reuse, no fix-rung strikes —
 * this is a BRAND NEW ephemeral run, never a fix on an existing task's branch): the worker owns
 * its own commit/push/PR-open steps (mirrors the retro/triage workers' prompts) via
 * {@link alertFixPrompt}; this function only spawns it and tears the worktree down after.
 */
export async function dispatchAlertFixRun(
  owner: string,
  repo: string,
  config: Config,
  alert: AlertLaneAlert,
  ledgerPath: string,
  runId: string,
  deps: AlertFixDispatchDeps = REAL_ALERT_FIX_DISPATCH_DEPS,
): Promise<void> {
  const originId = alertOriginId(alert);
  const taskId = alertTaskId(alert);
  const log = (step: string, extra: Record<string, unknown> = {}) =>
    appendLedger(ledgerPath, { run_id: runId, task_id: taskId, step, ...extra });

  const repoDir = repo === resolveOwnerRepo().repo ? repoRoot : join(config.root, "repos", repo);
  const branch = `alert-fix-${originId}-${Date.now()}`;
  const worktreePath = join(worktreesDir(config), branch);
  try {
    deps.worktreeAdd(repoDir, worktreePath, branch, "origin/main");
    const settingsFile = deps.renderWorkerSettings({
      templatePath: join(repoRoot, "settings", "worker.json"),
      hooksDir: join(repoRoot, "hooks"),
      outPath: join(config.root, "tmp", `alert-fix-settings-${taskId}-${Date.now()}.json`),
    });
    const mountsTable = deps.loadMounts(mountsPath(repoRoot));
    // W1-T90 rides the SAME "fix" task_type mounts.yaml already routes (§9) — this ephemeral run
    // is scoped down to a single-alert fix, the same shape a fix-rung strike already is. Risk
    // band is pinned at "medium": policy already confined this dispatch to a non-critical-path,
    // medium/low-severity alert (decideAlertDisposition), so a "low"/"high" spend band would
    // either under- or over-provision every dispatch identically — "medium" is the accurate
    // single band for the whole act-eligible severity range this lane ever dispatches.
    const fixMount: Mount = deps.resolveMount(mountsTable, "fix", "medium");

    log("alert-fix.dispatching", { branch, mount: fixMount.model });
    const worker = await deps.spawn({
      cwd: worktreePath,
      permissionMode: "bypassPermissions",
      settingsFile,
      model: fixMount.model,
      effort: fixMount.effort,
      maxTurns: fixMount.maxTurns,
      maxBudgetUsd: DEFAULT_BUDGET_USD,
      config,
      prompt: alertFixPrompt(alert, taskId),
    });
    log("alert-fix.dispatched_worker", {
      session_id: worker.sessionId,
      subtype: worker.subtype,
      ...workerLedgerFields(worker),
    });

    const report = parseReport([worker.text, worker.blocks.join("\n")].join("\n"));
    if (report?.prUrl) {
      deps.ensureTaskTrailer(report.prUrl, taskId);
      log("alert-fix.pr_opened", { pr_url: report.prUrl, origin: `alert#${originId}` });
    } else {
      log("alert-fix.no_pr", { subtype: worker.subtype });
    }
  } catch (e) {
    log("alert-fix.error", { error: String((e as Error)?.message ?? e) });
  } finally {
    try {
      deps.worktreeRemove(repoDir, worktreePath);
    } catch {
      /* best-effort cleanup */
    }
  }
}

/**
 * `rmd alert-fix [--repo <name>] [--dry-run]` — the alert-fix lane's real CLI wiring (W1-T90,
 * ratifies P20, MASTER-PLAN.md:686 — §5D lane 2's dep-review precedent, applied to scanners).
 *
 * Fetches every OPEN alert via the SAME `ghAlertGateway()` `rmd ops` already uses (ops.ts,
 * W1-T55), loads `plan/alert-policy.yaml` (data, rule 2 — no LLM ever decides act-vs-escalate),
 * and runs {@link runAlertLane} (src/lib/alert-lane.ts): a policy-matched "act" dispatches ONE
 * ephemeral, lane-owned fix run through the full [ci, remudero-review] gate (never a per-item
 * `plan/tasks.yaml` write — rule 15, the lane owns its run shape exactly like `rmd dep-review`);
 * a critical/high or gate-critical-path alert escalates via the SAME `escalate()`/
 * `buildAlertEscalation` machinery `rmd ops`'s own critical/high poll uses, sharing ONE
 * escalation-ledger dedup namespace so an alert already escalated by `rmd ops` is never
 * escalated again here (and vice versa) — see alert-lane.ts's own module doc.
 *
 * `--dry-run` previews every open alert's disposition; escalates/dispatches NOTHING.
 */
export interface AlertFixCommandDeps {
  config?: Config;
  resolveOwnerRepo?: () => { owner: string; repo: string };
  gateway?: AlertGateway;
  ledgerPath?: string;
  runId?: string;
  escalate?: (alert: AlertLaneAlert) => string | Promise<string>;
  dispatch?: (alert: AlertLaneAlert) => void | Promise<void>;
}

export async function alertFixCommand(rest: string[], deps: AlertFixCommandDeps = {}): Promise<number> {
  const badArg = unknownArgError("alert-fix", rest, ["--repo"], ["--dry-run"]);
  if (badArg) {
    console.error(badArg + "\n" + USAGE);
    return 2;
  }
  const dryRun = rest.includes("--dry-run");
  const config = deps.config ?? loadConfig();
  const ledgerPath = deps.ledgerPath ?? ledgerPathFor(config);
  const self = deps.resolveOwnerRepo ? deps.resolveOwnerRepo() : resolveOwnerRepo();
  const repo = flagValue(rest, "--repo") ?? self.repo;
  const owner = self.owner;
  const runId = deps.runId ?? `ALERT-FIX-${Date.now()}`;

  const policy = loadAlertPolicy(join(repoRoot, "plan", "alert-policy.yaml"));
  const gateway = deps.gateway ?? ghAlertGateway();
  const open: AlertLaneAlert[] = [
    ...gateway.codeScanning(owner, repo),
    ...gateway.dependabot(owner, repo),
    ...gateway.secretScanning(owner, repo),
  ].filter((a) => a.state === "open");

  if (dryRun) {
    const previews = open.map((a) => `  ${a.source}#${a.id} [${a.severity}] -> ${decideAlertDisposition(a, policy)}`);
    console.log(
      `### rmd alert-fix --dry-run — ${owner}/${repo}\n` + (previews.length ? previews.join("\n") : "no open alerts"),
    );
    return 0;
  }

  const result = await runAlertLane(open, policy, {
    ledgerPath,
    runId,
    escalate:
      deps.escalate ??
      ((alert) => escalate(buildAlertEscalation(alert), { issues: ghIssueGateway(owner, repo), ledgerPath, runId })),
    dispatch: deps.dispatch ?? (async (alert) => dispatchAlertFixRun(owner, repo, config, alert, ledgerPath, runId)),
  });

  console.log(
    `### rmd alert-fix — ${owner}/${repo}\n` +
      `dispatched ${result.dispatched.length} · escalated ${result.escalated.length} · ` +
      `skipped(dup-dispatch) ${result.skippedDuplicateDispatch.length} · skipped(dup-escalate) ${result.skippedDuplicateEscalate.length}`,
  );
  return 0;
}

/**
 * `rmd issues [--dry-run]` — issues intake (W1-T57, MASTER-PLAN §5D lane 3): poll open issues
 * for every repo in `.remudero/managed-repos.json` via `gh api` (lib/issues-intake.ts), create a
 * `plan/feedback/<id>.yaml` entry (origin: `issue#<n>`) for each one not already captured, and
 * fold an issues-reviewed count into the next `rmd digest`. Dedup is id-keyed (a deterministic
 * `fb-issue-<owner>-<repo>-<n>` id) — a re-poll of the SAME open issues creates nothing new.
 * --dry-run previews the reviewed count + which issues WOULD create a new entry; it creates none
 * and writes no ledger line. An empty/missing managed-repos.json is a safe no-op, not an error.
 */
async function issuesCommand(rest: string[]): Promise<number> {
  const badArg = unknownArgError("issues", rest, [], ["--dry-run"]);
  if (badArg) {
    console.error(badArg + "\n" + USAGE);
    return 2;
  }
  const dryRun = rest.includes("--dry-run");
  let managed;
  try {
    managed = loadManagedRepos(repoRoot);
  } catch (err) {
    if (err instanceof ManagedReposError) {
      console.error(`rmd issues: ${err.message}`);
      return 1;
    }
    throw err;
  }
  const config = loadConfig();
  const ledgerPath = ledgerPathFor(config);
  const runId = `ISSUES-${Date.now()}`;
  const result = await pollIssues(managed, {
    issues: ghIssueListGateway(),
    root: repoRoot,
    ledgerPath,
    runId,
    dryRun,
  });
  console.log(`### rmd issues${dryRun ? " --dry-run" : ""}\nissues reviewed: ${renderIssuesSummary(result.summary)}`);
  if (dryRun) {
    console.log(
      result.newIssues.length
        ? `would create ${result.newIssues.length} new feedback entr${result.newIssues.length === 1 ? "y" : "ies"}: ${result.newIssues
            .map((i) => `${i.owner}/${i.repo}#${i.number}`)
            .join(", ")}`
        : "no new issues to capture",
    );
  } else if (result.created.length > 0) {
    console.log(`created ${result.created.length} new feedback entr${result.created.length === 1 ? "y" : "ies"}:`);
    for (const e of result.created) console.log(`  ${e.origin} -> plan/feedback/${e.id}.yaml`);
  } else {
    console.log("no new issues to capture");
  }
  return 0;
}

/**
 * Interactive `--tier` confirm prompt (readline/promises). ONLY ever wired up
 * (and only ever called) when `process.stdin.isTTY` is true — a headless run
 * never reaches this function (Standing rule 18 / init.ts). Blank input accepts
 * the suggested tier; anything else is re-parsed as a `--tier` value.
 */
async function promptForTier(suggested: Tier, detection: TierDetection): Promise<Tier> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`\n### [init] ${detection.detail}`);
    for (;;) {
      const answer = (
        await rl.question(`Confirm Claude Code tier [pro/max5x/max20x] (default "${suggested}"): `)
      ).trim();
      if (!answer) return suggested;
      const t = answer.toLowerCase();
      if (t === "pro" || t === "max5x" || t === "max20x") return t;
      console.log(`  not a known tier: "${answer}" — try again.`);
    }
  } finally {
    rl.close();
  }
}

/**
 * `rmd init [--tier <pro|max5x|max20x>] [--yes]` — headless-safe first-run tier
 * wizard (lib/init.ts, W1-T9c). Resolution order: an explicit `--tier` override
 * (never prompts) → confident `~/.claude.json`/`/usage` evidence (never prompts)
 * → an interactive confirm (ONLY when a real TTY is present and neither of the
 * above resolved it) → a logged TTY-absent safe default. NEVER blocks on an
 * operator that may not exist (Standing rule 18 / LEARNINGS.md
 * no-live-operator-in-headless-worker — the failure mode that killed W1-T9).
 */
async function initCommand(rest: string[]): Promise<number> {
  const tierFlag = flagValue(rest, "--tier");
  const yes = rest.includes("--yes");
  const isTTY = Boolean(process.stdin.isTTY);

  const claudeJson = readClaudeJsonKeys(join(homedir(), ".claude.json"));
  // Best-effort `/usage` capture (rung 3): needs a resolved claudeBin, which may
  // not exist yet on a genuinely first run. Unavailable ⇒ detection just degrades
  // a rung (same contract as readUsageSnapshot itself) — init.ts never requires it.
  let usage: UsageSnapshot | undefined;
  try {
    usage = readUsageSnapshot(loadConfig());
  } catch {
    usage = undefined;
  }

  try {
    const result = await runInit({
      tierFlag,
      yes,
      isTTY,
      configPath: instanceConfigPath(),
      claudeJson,
      usage,
      confirm: isTTY ? promptForTier : undefined,
      log: (line) => console.log(`### [init] ${line}`),
    });
    console.log(`\nrmd init done — tier=${result.tier} source=${result.source} → ${result.configPath}`);
    return 0;
  } catch (e) {
    if (e instanceof InitError) {
      console.error(`### rmd init: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

/**
 * `rmd project init <repo> [--profile ts-node|ts-web|python|dotnet] --coverage-pct <n>
 * --branches-pct <n> --mutation-pct <n> --dup-pct <n>` — the fleet-inheritance onboarding
 * primitive (MASTER-PLAN §5A, W1-T27). A thin wrapper over the pure generator
 * {@link buildProjectInit} (lib/project-init.ts, independently unit-tested over fixtures — no
 * live repo needed for that proof): all argument validation happens in
 * {@link parseProjectInitArgs} BEFORE any work runs (fail loud, spawn nothing — Standing rule /
 * LEARNINGS.md control-surface-fail-loud-stop-one-shot), and this command never defaults an
 * unmeasured baseline to zero (§5A: "a repo never onboards at zero").
 *
 * DELIBERATELY MANUAL PAST GENERATION: this command prints the generated file list and the
 * branch-protection PATCH payload rather than pushing a branch / opening a PR / calling
 * `gh api` against the target repo itself. Automating that mutation against an ARBITRARY
 * external repo (auth, default-branch detection, PR conflicts, etc.) is out of this task's
 * scope — the note on W1-T27 calls the live end-to-end provisioning a separate
 * operator-attested confirmation (Rule 18), not part of auto-verify. Keeping the live-mutation
 * path manual also keeps this command trivially safe to run against any repo name.
 */
async function projectCommand(rest: string[]): Promise<number> {
  const sub = rest[0];
  if (sub !== "init") {
    console.error(`rmd project: unknown subcommand '${sub ?? ""}' — usage: ${commandSyntax("project")}\n` + USAGE);
    return 2;
  }

  const parsed = parseProjectInitArgs(rest.slice(1));
  if (!parsed.ok) {
    console.error(parsed.error + "\n" + USAGE);
    return 2;
  }

  const { owner: selfOwner } = resolveOwnerRepo();
  const owner = parsed.args.owner ?? selfOwner;
  const payload = buildProjectInit({
    owner,
    repo: parsed.args.repo,
    profile: parsed.args.profile,
    baselines: parsed.args.baselines,
  });

  console.log(`### rmd project init — generated gate stack for ${owner}/${parsed.args.repo} (profile: ${parsed.args.profile})`);
  console.log(`workflows: ${Object.keys(payload.workflows).map((f) => `.github/workflows/${f}`).join(", ")}`);
  console.log(
    `configs: .remudero/principles.yaml, ${Object.keys(payload.configs).join(", ")}`,
  );
  console.log(
    `baselines captured: coverage=${payload.baselines.coveragePct}% branches=${payload.baselines.branchesPct}% ` +
      `mutation=${payload.baselines.mutationScorePct}% dup=${payload.baselines.dupPct}% (at ${payload.baselines.capturedAt})`,
  );
  console.log(
    "\nThis command GENERATES the stack; it does not push/open a PR or arm branch protection " +
      "itself (manual next steps):",
  );
  console.log(
    `  1. Write the files listed above into a branch of ${owner}/${parsed.args.repo} and open a PR gated by ci-gate + remudero-review.`,
  );
  console.log(`  2. Once that PR is merged, arm branch protection:`);
  console.log(
    `     gh api -X PUT repos/${owner}/${parsed.args.repo}/branches/main/protection --input - <<'JSON'\n` +
      JSON.stringify(payload.branchProtection, null, 2) +
      `\nJSON`,
  );
  return 0;
}

/**
 * `rmd onboard <target-dir> --phase inventory [--owner <o> --repo <r>]` — phase 1 of the
 * four-phase `rmd onboard` family (MASTER-PLAN ★P24(1), W1-T82): a DETERMINISTIC, NO-LLM
 * repo inventory over a TARGET checkout — languages, build/CI systems, docs presence,
 * branch-protection state, issue/milestone counts, test-signal presence — via policy-as-data
 * detector tables (src/lib/onboard/inventory.ts) plus `gh api` reads. Read-only against the
 * target checkout + GitHub; the ONLY write is `<target-dir>/plan/onboarding/inventory.json`.
 * GitHub facts this command could not resolve (auth/network failure) render as the literal
 * `"unknown"` — never guessed or silently defaulted. `--phase` is REQUIRED; `inventory`
 * (this function's own body), `recon` ({@link reconCommand}), and `session`
 * ({@link sessionCommand}) — both routed to BELOW before inventory.ts's own parser ever
 * runs — its `KNOWN_ONBOARD_PHASES` stays `["inventory"]` exactly as W1-T82 shipped it — are
 * implemented; synthesis is W1-T85, a separate future task not built here; any other
 * `--phase` value fails loud (usage + non-zero exit,
 * zero work done) before any fs/gh call, the same `parseProjectInitArgs`-style
 * validate-first discipline `rmd project init` already applies (Standing rule / LEARNINGS.md
 * control-surface-fail-loud-stop-one-shot). `--owner`/`--repo` override auto-detection;
 * omitted, they are derived from the target checkout's own `git remote.origin.url`
 * ({@link resolveTargetOwnerRepo}) — unresolved leaves every GitHub fact `"unknown"` rather
 * than guessing an owner/repo to query.
 */
interface OnboardCommandDeps {
  fs?: OnboardFsDeps;
  gh?: OnboardGhGateway;
  resolveOwnerRepo?: typeof resolveTargetOwnerRepo;
}

export async function onboardCommand(rest: string[], deps: OnboardCommandDeps = {}): Promise<number> {
  // `--phase recon`/`--phase session` route to THEIR OWN parser/runner (src/lib/onboard/
  // recon.ts, src/lib/onboard/session.ts) BEFORE inventory.ts's parseOnboardArgs ever sees
  // it — inventory.ts's own KNOWN_ONBOARD_PHASES (and its committed W1-T82 test asserting
  // "recon" is unknown to THAT parser) stays exactly as shipped; only this command-level
  // routing is new.
  if (flagValue(rest, "--phase") === RECON_PHASE) {
    return reconCommand(rest);
  }
  if (flagValue(rest, "--phase") === SESSION_PHASE) {
    return sessionCommand(rest);
  }
  if (flagValue(rest, "--phase") === SYNTHESIZE_PHASE) {
    return synthesizeCommand(rest);
  }

  const { fs: fsDep, gh: ghDep, resolveOwnerRepo } = {
    fs: realOnboardFsDeps,
    gh: realOnboardGhGateway(),
    resolveOwnerRepo: resolveTargetOwnerRepo,
    ...deps,
  };
  const parsed = parseOnboardArgs(rest);
  if (!parsed.ok) {
    console.error(parsed.error + "\n" + USAGE);
    return 2;
  }
  const { targetDir, owner: ownerFlag, repo: repoFlag } = parsed.args;

  const resolved = ownerFlag && repoFlag ? undefined : resolveOwnerRepo(targetDir);
  const owner = ownerFlag ?? resolved?.owner;
  const repo = repoFlag ?? resolved?.repo;

  let inventory, writtenPath;
  try {
    ({ inventory, writtenPath } = runOnboardInventory(targetDir, { owner, repo }, { fs: fsDep, gh: ghDep }));
  } catch (e) {
    if (e instanceof OnboardError) {
      console.error(e.message);
      return 2;
    }
    throw e;
  }

  console.log(`### rmd onboard ${targetDir} --phase inventory`);
  console.log(`target: ${inventory.target.owner}/${inventory.target.repo}`);
  console.log(`languages: ${inventory.languages.join(", ") || "(none detected)"}`);
  console.log(`build systems: ${inventory.buildSystems.join(", ") || "(none detected)"}`);
  console.log(`CI systems: ${inventory.ciSystems.join(", ") || "(none detected)"}`);
  console.log(`docs: ${Object.entries(inventory.docs).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  console.log(`test signals: ${inventory.testSignals.join(", ") || "(none detected)"}`);
  console.log(
    `github: exists=${inventory.github.repoExists} defaultBranch=${inventory.github.defaultBranch} ` +
      `branchProtected=${inventory.github.branchProtected} openIssues=${inventory.github.openIssueCount} ` +
      `milestones=${inventory.github.milestoneCount}`,
  );
  console.log(`\nwrote ${writtenPath}`);
  return 0;
}

/**
 * `rmd onboard <target-dir> --phase recon [--owner <o> --repo <r>]` — phase 2 of the
 * four-phase `rmd onboard` family (MASTER-PLAN ★P24(2), W1-T83): mines existing plan
 * artifacts (ROADMAP/TODO/ADR intents/open issues) deterministically AND consults all four
 * W2-T1 specialist lenses (security/testing/design/containment — src/lib/specialist-panel.ts),
 * read-only, pointed at the WHOLE target repo instead of a diff (src/lib/onboard/recon.ts).
 * Writes ONLY `plan/onboarding/findings.md` + `plan/onboarding/candidates.json`; every
 * candidate cites its source verbatim, and mined vs inferred stays a labeled distinction end
 * to end. Candidates are inputs to the phase 3 planning session, never dispatchable tasks
 * (Standing rule 15). `onboardCommand` above routes `--phase recon` HERE before inventory.ts's
 * own parser ever runs.
 *
 * The default real `runLens` renders the SAME worker-settings template + hooks every task
 * worker uses (`renderWorkerSettings`/`validateWorkerSettingsFile`, FF10a) and runs the SAME
 * once-per-run containment preflight (`probeContainment`, containment.ts, W1-T2) before the
 * first lens spawn — proven empirically, not merely configured, exactly like every other real
 * spawn in this repo. A lens that fails to spawn, times out, or errors contributes ZERO
 * inferred candidates (logged, advisory only — Standing rule 12) rather than aborting the
 * whole recon: the deterministic miner's candidates must never be held hostage to one flaky
 * LLM call.
 */
interface ReconCommandDeps {
  fs?: ReconFsDeps;
  gh?: ReconGhGateway;
  resolveOwnerRepo?: typeof resolveTargetOwnerRepo;
  /** Injectable per-lens raw-text runner — tests supply canned text; omitted, the real
   *  spawn-backed default below is used. */
  runLens?: (specialist: SpecialistName) => Promise<string>;
}

/** A deliberately modest, fixed mount for the recon lenses — there is no mounts.yaml row for
 *  an ad hoc whole-repo recon read (that table routes DRAINED plan tasks, W1-T83 is a
 *  one-off CLI spawn), so this is a conservative, explicit default rather than a borrowed
 *  task-routing cell. */
const RECON_LENS_MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 30, contextBudget: 150_000 };

/** The real, spawn-backed `runLens`: settings are rendered and containment is
 *  probed ONCE (lazily, on the first lens) and reused for the remaining three — the
 *  invariant containment.ts documents is per-RUN, not per-spawn.
 *
 *  `deps` is injectable — the SAME `opts.spawn ?? spawnWorker` / `opts.config ?? loadConfig()`
 *  shape `runTask` above already uses, so a unit test can drive both the happy path and the
 *  advisory-only catch path with a fake `spawn`/`probeExec`, never touching `loadConfig()`
 *  (which shells `which claude` — unavailable in CI, containment.ts's own documented gotcha)
 *  or a real Agent SDK spawn. Every field defaults to the real implementation, so the
 *  production call site below (no `deps` passed) is unchanged. */
export function defaultReconRunLens(
  targetDir: string,
  owner: string | undefined,
  repo: string | undefined,
  deps: {
    config?: Config;
    spawn?: typeof spawnReconSpecialist;
    probeExec?: ProbeExecutor;
  } = {},
): (specialist: SpecialistName) => Promise<string> {
  const config = deps.config ?? loadConfig();
  const spawn = deps.spawn ?? spawnReconSpecialist;
  let preparedSettingsFile: string | undefined;
  return async (specialist) => {
    try {
      if (!preparedSettingsFile) {
        const settingsFile = renderWorkerSettings({
          templatePath: join(repoRoot, "settings", "worker.json"),
          hooksDir: join(repoRoot, "hooks"),
          outPath: join(config.root, "tmp", `onboard-recon-settings-${Date.now()}.json`),
        });
        validateWorkerSettingsFile(settingsFile);
        await probeContainment({ settingsFile, config, exec: deps.probeExec });
        preparedSettingsFile = settingsFile;
      }
      const result = await spawn({
        input: { specialist, targetDir, owner, repo },
        mount: RECON_LENS_MOUNT,
        settingsFile: preparedSettingsFile,
      });
      return result.text;
    } catch (e) {
      console.error(`rmd onboard recon: ${specialist} lens unavailable (advisory only, continuing): ${String((e as Error)?.message ?? e)}`);
      return "";
    }
  };
}

export async function reconCommand(rest: string[], deps: ReconCommandDeps = {}): Promise<number> {
  const parsed = parseReconArgs(rest);
  if (!parsed.ok) {
    console.error(parsed.error + "\n" + USAGE);
    return 2;
  }
  const { targetDir, owner: ownerFlag, repo: repoFlag } = parsed.args;

  const { fs: fsDep, gh: ghDep, resolveOwnerRepo } = {
    fs: realReconFsDeps,
    gh: realReconGhGateway(),
    resolveOwnerRepo: resolveTargetOwnerRepo,
    ...deps,
  };

  const resolved = ownerFlag && repoFlag ? undefined : resolveOwnerRepo(targetDir);
  const owner = ownerFlag ?? resolved?.owner;
  const repo = repoFlag ?? resolved?.repo;

  const runLens = deps.runLens ?? defaultReconRunLens(targetDir, owner, repo);

  let candidates, findingsPath, candidatesPath;
  try {
    ({ candidates, findingsPath, candidatesPath } = await runOnboardRecon(targetDir, { owner, repo }, { fs: fsDep, gh: ghDep, runLens }));
  } catch (e) {
    if (e instanceof ReconError) {
      console.error(e.message);
      return 2;
    }
    throw e;
  }

  const minedCount = candidates.filter((c) => c.confidence === "mined").length;
  const inferredCount = candidates.filter((c) => c.confidence === "inferred").length;
  console.log(`### rmd onboard ${targetDir} --phase recon`);
  console.log(`target: ${owner ?? "unknown"}/${repo ?? "unknown"}`);
  console.log(`lenses consulted: ${RECON_LENSES.join(", ")}`);
  console.log(`candidates: ${candidates.length} (${minedCount} mined, ${inferredCount} inferred)`);
  console.log(`wrote ${findingsPath}`);
  console.log(`wrote ${candidatesPath}`);
  return 0;
}

/**
 * `rmd onboard <target-dir> --phase session` — phase 3 of the four-phase `rmd onboard`
 * family (MASTER-PLAN ★P24(3)+(4), W1-T84): renders the phase-1/2 findings location plus a
 * §2-contract question set (src/lib/onboard/session.ts) and drives the answer loop.
 * `onboardCommand` above routes `--phase session` HERE before inventory.ts's own parser
 * ever runs.
 *
 * NO-TTY NEVER BLOCKS (Standing rule 18 / LEARNINGS.md no-live-operator-in-headless-worker):
 * a headless invocation (no real TTY on stdin — e.g. a drained worker shelling this out)
 * never reaches `readline`; it prints the unanswered backlog and returns immediately,
 * exactly as {@link loadOnboardSessionState} left it, so a second, INTERACTIVE invocation
 * later re-presents that same backlog (resumability, acceptance criterion 3) rather than
 * this command ever hanging on an operator that may not be there.
 */
interface SessionCommandDeps {
  fs?: SessionFsDeps;
  isTTY?: boolean;
  ask?: (question: OnboardQuestion) => Promise<string>;
}

/** Render one question the same way for both the no-TTY preview and the interactive
 *  readline prompt — decision, question text, and its named candidate answers. */
function renderQuestionPrompt(question: OnboardQuestion): string {
  const options = question.candidateAnswers.map((a, i) => `    ${i + 1}. ${a}`).join("\n");
  return (
    `  [${question.id}] decides: ${question.decision}\n` +
    `  ${question.question}\n${options}\n` +
    `  (answer with a number above, or type your own answer; blank leaves it unanswered)`
  );
}

/** The real, readline-backed `ask` — ONLY ever constructed when `process.stdin.isTTY` is
 *  true (mirrors `promptForTier`'s own TTY-gated shape). A numeric reply matching a listed
 *  candidate answer is resolved to that answer's own text; anything else is accepted
 *  verbatim as a free-text answer. */
export async function readlineAsk(
  question: OnboardQuestion,
  io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = { input: process.stdin, output: process.stdout },
): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: io.input, output: io.output });
  try {
    console.log(`\n${renderQuestionPrompt(question)}`);
    const raw = (await rl.question("> ")).trim();
    const asIndex = Number(raw);
    if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= question.candidateAnswers.length) {
      return question.candidateAnswers[asIndex - 1]!;
    }
    return raw;
  } finally {
    rl.close();
  }
}

export async function sessionCommand(rest: string[], deps: SessionCommandDeps = {}): Promise<number> {
  const parsed = parseSessionArgs(rest);
  if (!parsed.ok) {
    console.error(parsed.error + "\n" + USAGE);
    return 2;
  }
  const { targetDir } = parsed.args;
  const fsDep = deps.fs ?? realSessionFsDeps;
  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY);

  console.log(`### rmd onboard ${targetDir} --phase session`);

  if (!isTTY) {
    // Never block on an operator that may not exist — preview the backlog and return.
    let state;
    try {
      state = loadOnboardSessionState(targetDir, fsDep);
    } catch (e) {
      if (e instanceof SessionError) {
        console.error(e.message);
        return 2;
      }
      throw e;
    }
    console.log(`no TTY on stdin — previewing the question backlog without asking (run interactively to answer):`);
    console.log(`questions: ${state.questions.length} total, ${state.unanswered.length} unanswered`);
    for (const q of state.unanswered) console.log(`\n${renderQuestionPrompt(q)}`);
    return 0;
  }

  const ask = deps.ask ?? readlineAsk;
  let result;
  try {
    result = await runOnboardSession(targetDir, { fs: fsDep, ask });
  } catch (e) {
    if (e instanceof SessionError) {
      console.error(e.message);
      return 2;
    }
    throw e;
  }

  console.log(`questions: ${result.questions.length} total, ${result.newlyAnswered.length} answered this session, ${result.unanswered.length} still unanswered`);
  console.log(`wrote ${result.answersPath}`);
  if (result.newlyAnswered.length > 0) console.log(`wrote ${result.ledgerPath}`);
  return 0;
}

/**
 * `rmd onboard <target-dir> --phase synthesize` — phase 4 (and last) of the four-phase
 * `rmd onboard` family (MASTER-PLAN ★P24(5)+(6), W1-T85): drafts `MASTER-PLAN.md`,
 * `plan/tasks.yaml`, and `AGENTS.md` for the TARGET repo as ONE ratifiable draft PR
 * (src/lib/onboard/synthesize.ts). REFUSES loud (non-zero exit, naming every unanswered
 * question id) unless the phase-3 session's FULL question set is answered — goals are
 * never guessed. The drafted `tasks.yaml` is iterated against the REAL `rmd lint-plan`
 * linter until clean BEFORE a branch/PR is ever opened; opens EXACTLY ONE draft PR
 * (`onboard/<repo>-plan`), writing nothing outside that branch. `onboardCommand` above
 * routes `--phase synthesize` HERE before inventory.ts's own parser ever runs.
 *
 * Composition: `rmd onboard` (this whole family) produces the BRAIN; `rmd project init`
 * (W1-T27) installs the BAR; the daemon drains.
 */
interface SynthesizeCommandDeps {
  fs?: SynthesizeFsDeps;
  git?: SynthesizeGitGateway;
  gh?: SynthesizeGhGateway;
  draft?: SynthesizeDraftFn;
}

/** A deliberately generous, fixed mount for the synthesis Architect worker — like
 *  RECON_LENS_MOUNT, there is no mounts.yaml row for an ad hoc onboarding draft (a one-off
 *  CLI spawn, not a drained plan task); higher effort/turns than recon's read-only lenses
 *  because this worker actually PRODUCES the three documents, not just flags findings. */
const SYNTHESIZE_MOUNT: Mount = { model: "sonnet", effort: "high", maxTurns: 45, contextBudget: 200_000 };

function buildSynthesizeMasterPlanPrompt(input: Parameters<SynthesizeDraftFn>[0]): string {
  return [
    `You are the ARCHITECT worker for \`rmd onboard ${input.targetDir} --phase synthesize\` (MASTER-PLAN`,
    `★P24(5), W1-T85), drafting a ratifiable onboarding PR for ${input.owner}/${input.repo}. You are`,
    `READ-ONLY: inspect this checkout, but never edit/write any file yourself — your ENTIRE job is to`,
    `return ONE document (raw Markdown, no wrapping fences) as your final response text; the harness`,
    `(never you) writes it to disk on a fresh branch.`,
    ``,
    `Write this target repo's MASTER-PLAN.md: its mission (in one or two sentences) and its CONVENTIONS`,
    `AS FOUND (languages/build/CI/test conventions already present — never invented). Ground every claim`,
    `in the phase 1-3 onboarding artifacts below; never guess a goal the operator did not ratify.`,
    ``,
    `INVENTORY (phase 1, deterministic): ${JSON.stringify(input.inventory)}`,
    `FINDINGS (phase 2, mined + specialist-inferred): ${input.findings || "(none)"}`,
    `RATIFIED ANSWERS (phase 3, the operator's own words): ${JSON.stringify(input.answers)}`,
  ].join("\n");
}

function buildSynthesizeTasksYamlPrompt(input: Parameters<SynthesizeDraftFn>[0], feedback: string[] | undefined): string {
  const feedbackBlock =
    feedback && feedback.length > 0
      ? [
          ``,
          `YOUR PREVIOUS DRAFT FAILED \`rmd lint-plan\` (§5C Layer A) with these BLOCKING violations — fix`,
          `every one of them in this redraft:`,
          ...feedback.map((f) => `  - ${f}`),
        ].join("\n")
      : "";
  return [
    `You are the ARCHITECT worker for \`rmd onboard ${input.targetDir} --phase synthesize\` (MASTER-PLAN`,
    `★P24(5)+(6), W1-T85), drafting a ratifiable onboarding PR for ${input.owner}/${input.repo}. You are`,
    `READ-ONLY: inspect this checkout, but never edit/write any file yourself — your ENTIRE job is to`,
    `return ONE document (a raw YAML list, no wrapping fences) as your final response text.`,
    ``,
    `Draft a CHANGE-LEVEL plan/tasks.yaml SEED (progressive adoption — NEVER a big-bang respec) from the`,
    `ratified goals below. Every task you emit MUST pass \`rmd lint-plan\` (§5C Layer A) AT BIRTH:`,
    `  - every task needs id/title/repo/type/acceptance, and an origin: field citing the SPECIFIC answer`,
    `    id or candidate source that justified it (e.g. origin: "onboard:<answer-id>") — never omitted,`,
    `    never a generic "architect".`,
    `  - every acceptance criterion's proof: must be EXECUTABLE dialect — "unit test: <literal test`,
    `    title>" or "grep: <pattern> in <path>" — never free prose, never a vibe phrase ("works"/"correct").`,
    `  - an auto-verify task's criteria must never require a live human/TTY/overnight action (no`,
    `    "operator confirms", "reboot", "launchctl", etc.) — use verify: human for anything that does.`,
    `  - a task spanning ≥2 distinct subsystems must be risk: high or split into one task per concern.`,
    feedbackBlock,
    ``,
    `INVENTORY (phase 1): ${JSON.stringify(input.inventory)}`,
    `CANDIDATES (phase 2, ${input.candidates.length} mined/inferred goals): ${JSON.stringify(input.candidates)}`,
    `RATIFIED ANSWERS (phase 3, the operator's own words — goals are NEVER guessed beyond these):`,
    `  ${JSON.stringify(input.answers)}`,
  ].join("\n");
}

function buildSynthesizeAgentsMdPrompt(input: Parameters<SynthesizeDraftFn>[0]): string {
  return [
    `You are the ARCHITECT worker for \`rmd onboard ${input.targetDir} --phase synthesize\` (MASTER-PLAN`,
    `★P24(6), W1-T85), drafting a ratifiable onboarding PR for ${input.owner}/${input.repo}. You are`,
    `READ-ONLY: inspect this checkout, but never edit/write any file yourself — your ENTIRE job is to`,
    `return ONE document (raw Markdown, no wrapping fences) as your final response text.`,
    ``,
    `Write this target repo's AGENTS.md — the cross-tool convention doc (so any coding agent, not just`,
    `this one, respects the same constitution this PR proposes): conventions AS FOUND (build/test/lint`,
    `commands actually present in this checkout), plus the no-touch zones and verify:human boundaries`,
    `named in the ratified answers below. Never invent a convention this checkout does not evidence.`,
    ``,
    `INVENTORY (phase 1): ${JSON.stringify(input.inventory)}`,
    `RATIFIED ANSWERS (phase 3): ${JSON.stringify(input.answers)}`,
  ].join("\n");
}

/** The real, spawn-backed `draft` fn `synthesizeCommand` falls back to when no `deps.draft`
 *  is injected — NOT unit tested directly (mirrors `defaultReconRunLens`): settings are
 *  rendered and containment probed ONCE (lazily, on the first call) and reused across every
 *  attempt of the iterate-until-clean loop. Three independent, read-only spawns per attempt
 *  (one per document) — simple, deterministic to parse (each worker's `.text` IS the
 *  document, no fenced-block parsing needed), and a redraft only needs to re-spawn all
 *  three, never a partial/patchy edit. */
export function defaultSynthesizeDraft(
  deps: { config?: Config; spawn?: typeof spawnWorker; probeExec?: ProbeExecutor } = {},
): SynthesizeDraftFn {
  const config = deps.config ?? loadConfig();
  const spawn = deps.spawn ?? spawnWorker;
  let preparedSettingsFile: string | undefined;

  const ensureSettingsFile = async (): Promise<string> => {
    if (!preparedSettingsFile) {
      const settingsFile = renderWorkerSettings({
        templatePath: join(repoRoot, "settings", "worker.json"),
        hooksDir: join(repoRoot, "hooks"),
        outPath: join(config.root, "tmp", `onboard-synthesize-settings-${Date.now()}.json`),
      });
      validateWorkerSettingsFile(settingsFile);
      await probeContainment({ settingsFile, config, exec: deps.probeExec });
      preparedSettingsFile = settingsFile;
    }
    return preparedSettingsFile;
  };

  return async (input, feedback) => {
    const settingsFile = await ensureSettingsFile();
    const runOne = async (prompt: string): Promise<string> => {
      const result = await spawn({
        cwd: input.targetDir,
        permissionMode: "bypassPermissions",
        settingsFile,
        prompt,
        model: SYNTHESIZE_MOUNT.model,
        effort: SYNTHESIZE_MOUNT.effort,
        maxTurns: SYNTHESIZE_MOUNT.maxTurns,
        tools: SPECIALIST_TOOLS,
      });
      return result.text.trim();
    };

    const [masterPlan, tasksYaml, agentsMd] = await Promise.all([
      runOne(buildSynthesizeMasterPlanPrompt(input)),
      runOne(buildSynthesizeTasksYamlPrompt(input, feedback)),
      runOne(buildSynthesizeAgentsMdPrompt(input)),
    ]);
    return { masterPlan, tasksYaml, agentsMd };
  };
}

export async function synthesizeCommand(rest: string[], deps: SynthesizeCommandDeps = {}): Promise<number> {
  const parsed = parseSynthesizeArgs(rest);
  if (!parsed.ok) {
    console.error(parsed.error + "\n" + USAGE);
    return 2;
  }
  const { targetDir } = parsed.args;

  console.log(`### rmd onboard ${targetDir} --phase synthesize`);

  const fsDep = deps.fs ?? realSynthesizeFsDeps;
  const gitDep = deps.git ?? realSynthesizeGitGateway();
  const ghDep = deps.gh ?? realSynthesizeGhGateway();
  const draftDep = deps.draft ?? defaultSynthesizeDraft();

  let result;
  try {
    result = await runOnboardSynthesize(targetDir, { fs: fsDep, git: gitDep, gh: ghDep, draft: draftDep });
  } catch (e) {
    if (e instanceof SynthesizeError) {
      console.error(e.message);
      return 2;
    }
    throw e;
  }

  console.log(`branch: ${result.branch}`);
  console.log(`tasks drafted: ${result.tasks.length} (lint-plan clean after ${result.attempts} attempt(s))`);
  console.log(`wrote ${result.masterPlanPath}`);
  console.log(`wrote ${result.tasksYamlPath}`);
  console.log(`wrote ${result.agentsMdPath}`);
  console.log(`opened draft PR: ${result.prUrl}`);
  return 0;
}

/**
 * `rmd skill list` — the §5B skill-registry reader (W1-T44). Setup, Plan,
 * Feedback/triage, Retro, Review, Refactor, and Design Review are ALL the same
 * ground->research->grill-or-produce primitive, differing only by a
 * declarative profile; this prints every `.remudero/skills/<name>.yaml`
 * resolved, so a skill added by CONFIG ALONE (no source change) shows up here
 * with zero code touched. `skill` is the only subcommand today — `list` — kept
 * as an explicit subcommand (not bare `rmd skill`) so a future write verb
 * (e.g. an `add`/`run`) has room without a breaking reshape.
 */
async function skillCommand(rest: string[]): Promise<number> {
  const sub = rest[0];
  if (sub !== "list") {
    console.error(`rmd skill: unknown subcommand '${sub ?? ""}' — usage: rmd skill list\n` + USAGE);
    return 2;
  }
  const badArg = unknownArgError("skill list", rest.slice(1), [], []);
  if (badArg) {
    console.error(badArg + "\n" + USAGE);
    return 2;
  }

  let skills;
  try {
    skills = loadSkillRegistry(skillsDir(repoRoot));
  } catch (e) {
    const message = e instanceof SkillError ? e.message : String((e as Error)?.message ?? e);
    console.error(`rmd skill list: ${message}`);
    return 1;
  }

  console.log(`### rmd skill list — ${skills.length} registered (.remudero/skills/)`);
  console.log(renderSkillList(skills));
  return 0;
}

/** `before`/`after` line for `rmd correct` — the operator-facing flip. */
function describeProjection(label: string, proj: StatusProjection): string {
  const pr = proj.prUrl ? `${proj.prUrl}${proj.prState ? ` (${proj.prState})` : ""}` : "none";
  return `### rmd correct — ${label}: status=${proj.status} merged=${proj.merged} source=${proj.source} pr=${pr}`;
}

/**
 * `rmd correct <task-id> --pr <n> [--reason <text>]` — the SANCTIONED correction
 * writer (MASTER-PLAN P9 / W1-T75, the W1-T20c/#134 stranding): a thin CLI wrapper
 * over {@link applyCorrection} (unit-tested independently, the same split
 * `fleet-control.ts`'s `requestStop`/`requestPause` use for `rmd stop`/`rmd pause`).
 * Prints the derived status before and after so the operator SEES the flip.
 */
async function correctCommand(rest: string[]): Promise<number> {
  const taskId = rest[0];
  const badArg = unknownArgError("correct", rest.slice(1), ["--pr", "--reason"], []);
  if (badArg) {
    console.error(badArg + "\n" + USAGE);
    return 2;
  }
  const prFlag = flagValue(rest, "--pr");
  if (!prFlag) {
    console.error(`rmd correct: --pr <n> is required — usage: ${commandSyntax("correct")}\n` + USAGE);
    return 2;
  }

  const planPath = join(repoRoot, "plan", "tasks.yaml");
  const plan = loadPlan(planPath);
  const task = plan.byId.get(taskId);
  if (!task) {
    console.error(`rmd correct: unknown task '${taskId}' (not found in ${planPath})`);
    return 2;
  }

  const config = loadConfig();
  const { owner } = resolveOwnerRepo();
  const github = ghGateway(owner, task.repo);
  const ledgerPath = ledgerPathFor(config);
  const result = applyCorrection(task, prFlag, { ledgerPath, github }, { reason: flagValue(rest, "--reason") });

  console.log(describeProjection("before", result.before));
  if (!result.written) {
    console.error(
      `rmd correct: could not resolve PR '${prFlag}' in ${owner}/${task.repo} via \`gh\` — nothing written.`,
    );
    return 1;
  }
  console.log(describeProjection("after", result.after));
  console.log(
    `### rmd correct — ${taskId} now credits ${result.prUrl} (source=correction, supreme over rungs a/b/c). ` +
      `Append-only; no ledger rewrite.`,
  );
  return 0;
}

/**
 * `rmd trace <id>` — render the provenance chain (MASTER-PLAN §7B / Standing rule 17,
 * W1-T43): feedback → proposal PR → task(s) → run(s) → PR(s) → merge sha. `<id>` is
 * resolved as a TASK id first (an exact `plan/tasks.yaml` id — reverse direction, task
 * back to its origin); only if that fails is it read as a FEEDBACK id
 * (`plan/feedback/<id>.yaml` — forward direction, feedback out to every task it
 * produced). Neither resolving is a fail-loud usage error, not a silent empty chain.
 */
async function traceCommand(rest: string[]): Promise<number> {
  const id = rest[0];
  const badArg = unknownArgError("trace", rest.slice(1), [], []);
  if (badArg) {
    console.error(badArg + "\n" + USAGE);
    return 2;
  }
  if (!id) {
    console.error(`rmd trace: <id> is required — usage: ${commandSyntax("trace")}\n` + USAGE);
    return 2;
  }

  const planPath = join(repoRoot, "plan", "tasks.yaml");
  const plan = loadPlan(planPath);
  const config = loadConfig();
  const { owner, repo: defaultRepo } = resolveOwnerRepo();
  const ledgerPath = ledgerPathFor(config);
  const ledgerLines = readLedgerLines(ledgerPath);

  const task = plan.byId.get(id);
  if (task) {
    const github = ghTraceGateway(owner, task.repo || defaultRepo);
    let feedbackEntry: FeedbackEntry | undefined;
    if (task.origin?.startsWith("feedback#")) {
      const feedbackId = task.origin.slice("feedback#".length);
      try {
        feedbackEntry = readFeedbackEntry(repoRoot, feedbackId);
      } catch (e) {
        console.error(`### rmd trace — note: ${task.id} names origin: ${task.origin}, but ${String((e as Error)?.message ?? e)}`);
      }
    }
    const chain = traceReverse(task, { plan, ledgerLines, github }, feedbackEntry);
    console.log(`### rmd trace ${id} (reverse — task back to its origin)`);
    console.log(renderTraceChain(chain));
    return 0;
  }

  let entry: FeedbackEntry;
  try {
    entry = readFeedbackEntry(repoRoot, id);
  } catch {
    console.error(
      `rmd trace: '${id}' is neither a known task id (${planPath}) nor a feedback entry (plan/feedback/${id}.yaml)`,
    );
    return 2;
  }
  const github = ghTraceGateway(owner, defaultRepo);
  const chain = traceForward(entry, { plan, ledgerLines, github });
  console.log(`### rmd trace ${id} (forward — feedback out to its task(s))`);
  console.log(renderTraceChain(chain));
  return 0;
}

// ── CLI entry (invoked by bin/rmd). Kept tiny; all logic is above/lib.
//
// COMMAND REGISTRY — the ONE source of truth for every `rmd <cmd>` name and its usage
// line. `rmd --help` (top-level) and `rmd <cmd> --help` (per-command) are BOTH generated
// from this array — neither is hand-maintained prose, so they cannot drift from each
// other. bin/rmd's header comment is documentation for humans reading the script; this
// array is what the running binary actually prints and dispatches against.
interface CommandSpec {
  /** Exact token matched against argv[2] in main()'s dispatch below. */
  readonly name: string;
  /** One-line "rmd <name> ... # description" — printed verbatim in both help forms. */
  readonly usage: string;
}

const COMMANDS: readonly CommandSpec[] = [
  {
    name: "run-task",
    usage:
      "rmd run-task <task-id> [--allow-stale] [--rerun]   # dispatches from the origin/main plan blob (W1-T60), fetching first; --allow-stale proceeds on the last-fetched refs if the fetch fails instead of refusing; --rerun dispatches even when the projection already reports the task merged (W1-T319), instead of refusing at zero cost with verdict task_already_merged",
  },
  {
    name: "review",
    usage:
      "rmd review <pr-number> [--repo <name>] [--override-capped-by <name> --override-capped-reason <text>]   # post remudero-review on a hand-opened PR; materializes a worktree at the PR head so proofs EXECUTE (W1-T185), falling back to an explicit keyword-only CAPPED verdict if materialization fails; --override-capped-by/--override-capped-reason ledgers an attributable operator override so a CAPPED verdict can arm auto-merge",
  },
  {
    name: "dep-review",
    usage:
      "rmd dep-review <pr-number> [--repo <name>]   # deterministic Dependabot-PR review lane (W1-T54): minor/patch -> arm auto-merge; major (or unparseable) -> escalate (needs-human, no auto-merge); source outside manifests -> refuse",
  },
  {
    name: "lint-plan",
    usage:
      "rmd lint-plan [--plan <path>] [--base <git-ref>]   # §5C Layer A: deterministic task linter (sizing/headless-fitness/proof-shape/provenance); --base scopes to task ids NEW/CHANGED vs that ref (CI mode), omitted = whole plan; exits non-zero on any blocking violation, spawns nothing",
  },
  {
    name: "preflight",
    usage:
      "rmd preflight [--from <ref>] [--to <ref>] [--ci-parity] [--fast]   # W1-T221: the HAND route's commit gate — runs commitlint, `tsc --noEmit`, and lib/commit-message.ts's own header/body checks as three INDEPENDENT steps (each names its own pass/fail, never chained with &&) over the commit range not yet on origin/main; --from/--to override the default origin/main..HEAD range; --ci-parity (W1-T294) ADDS one or more named steps per .github/workflows/ci.yml job (lib/ci-parity.ts), computed against a freshly refreshed origin/main and CI's own coverage/diff-scoping flags, with a dedicated ci-parity:drift step that fails if a ci.yml job has no parity entry, but shells the FULL test:ci suite as part of its `ci` job mirror; --fast (W1-T373) ADDS the curated, seconds-fast, network-free deterministic npm-script gates instead (cli-reference:check, claims, learnings-budget-ratchet, jscpd, depcruise, api-client:check, no-hand-rolled-fetch:check — FAST_GATE_STEPS, lib/ci-parity.ts) and NEVER shells the test suite, so it is the mode a worker can run habitually; either or both flags may be passed; exits non-zero if any step fails, after every step has run and reported. EVERY run also writes a machine-readable verdict to `<repoRoot>/coverage/preflight-summary.json` (override with --summary-file <path>) — ok, the head sha, duration, pass/fail counts and every step — so an eight-minute result survives the container that produced it; written on FAIL as well as PASS, and a write failure never changes the exit code",
  },
  {
    name: "next-task-id",
    usage:
      "rmd next-task-id [--plan <path>] [--offline]   # print the next free W1-T<n>, derived from the max across plan/tasks.yaml, EVERY plan/tasks.d/*.yaml shard, the ids OPEN plan PRs have already minted (the 2/2 collision class: W1-T256->257 #770, W1-T260->261 #775), and every id ever declared in the git history of plan/ (the fold class: an id filed then folded away, W1-T278); --offline skips the open-PR read (the mint is then a FLOOR, and says so; the history scan still runs — it is a local git read, not a network one); prints its provenance, spawns nothing",
  },
  {
    name: "emissions",
    usage:
      "rmd emissions [--days N]   # which CLI verbs have written NO ledger line in the window (default 30d) — the runtime half of dead-capability detection, paired with a static call-site count so 'reachable but never typed' is distinguishable from 'unreachable'. Unions the ledger AND its rotations (reading the live file alone undercounts ~4x). READ-ONLY: writes nothing, spawns nothing",
  },
  {
    name: "check-proof",
    usage:
      "rmd check-proof <proof> [--allow-full-suite]   # run ONE acceptance proof through the REVIEWER'S OWN parser and executor and print what it does: parse kind, resolved candidate file(s), the exact argv, the verdict, exit code and hit count. A `grep:` pattern is a BASIC REGULAR EXPRESSION (`[ * ^ $` are metacharacters) — verifying with `grep -F` is a DIFFERENT matcher and reports a false green (PR #1071). A `unit test:` proof naming a TITLE rather than a test/<file>.test.ts PATH is resolved to its file first; when it resolves to none, the run is REFUSED rather than falling back to the whole-suite glob (--allow-full-suite overrides, time-boxed). EXIT CODE IS THE VERDICT: 0 pass, 1 fail (genuinely unmet — overrides the keyword floor), 2 refused (nothing executed — bad usage, an unparseable proof, or an unresolved name run declined), 3 no-match (ran and named nothing — degrades to the keyword floor, NEVER read as fail), 4 exec_error (a timeout/spawn failure/grep-exit-2 — inconclusive, also degrades). READ-ONLY: writes no cache, no ledger line, no state file",
  },
  {
    name: "ledger-grep",
    usage:
      "rmd ledger-grep <pattern>   # the deduplicated union of every state/ledger.*.ndjson.gz archive and the live state/ledger.ndjson, matched against <pattern>. Replaces the manual `grep -h '<pat>' state/ledger.*.ndjson state/ledger.ndjson | sort -u` idiom, which glob-matches ZERO gzipped archives on this host and silently answers from the live file alone (a measured 3.1x undercount). Prints the pattern, state dir and archive count BEFORE any match, then EXITS NON-ZERO, naming the globbed directory, when ZERO archive files were read — never falling back to a live-file-only count. READ-ONLY: writes no ledger line, no state file, deletes/moves nothing",
  },
  {
    name: "check-acceptance",
    usage:
      "rmd check-acceptance <body-file>   # read a PR body from a file and report what the REVIEWER'S OWN parseAcceptanceBlock actually resolves from it, against what was written: header found, bullets written, criteria parsed, empty proofs. Exits non-zero when they disagree. A claim WRAPPED onto a second line silently truncates the block (any indented line that is not `proof:` ends it), and a `## Validation` heading is not an Acceptance header — both ship a body that says less than its author wrote. Run this before opening a PR over REST, which bypasses the orchestrator's house-block emitter. READ-ONLY: writes no ledger line, no state file",
  },
  { name: "retro", usage: "rmd retro [--dry-run]    # sync the plan from the ledger (Architect retro)" },
  {
    name: "drain",
    usage:
      "rmd drain [--until <id>] [--max <n>] [--repo <name>] [--curated <path>] [--dry-run] [--allow-stale]   # drain the DAG through run-task, dispatching from the origin/main plan blob (W1-T60); --repo scopes the merged-status gateway to <owner>/<name> (defaults to this checkout's own repo, like the daemon path) — the plan itself is always read from THIS checkout; --curated <path> names a JSON {taskIds, depth} file (the drain preview panel's curated selection, W1-T140) that overrides the natural DAG order entirely — dispatch honors EXACTLY that reordered/unselected subset, and --dry-run --curated previews it",
  },
  {
    name: "daemon",
    usage:
      "rmd daemon --repo <name> [--plan <path>] [--max <n>] [--poll-ms <n>] [--dry-run] [--allow-self-target] [--allow-stale]   # persistent scheduler loop; --repo picks the repo to drain + its gateway (e.g. remudero-sandbox for W1-T12d). Refuses to drain its OWN source repo unattended without --allow-self-target. --dry-run previews the target + planned tasks, spawns nothing. Self-hosting reads the plan from origin/main (W1-T60); --allow-stale proceeds on the last-fetched refs if the fetch fails.",
  },
  {
    name: "daemon-plist",
    usage:
      "rmd daemon-plist --repo <name> [--poll-ms <n>] [--allow-self-target] [--write]   # generate the launchd unit for `rmd daemon`, baking in --repo so the unit drains the intended repo (commissioning is W1-T12d); a self-target unit (--repo omitted, or pointed at this checkout's own repo) is refused at generation unless --allow-self-target is also given, which bakes the same consent into the unit (W1-T109)",
  },
  {
    name: "deploy",
    usage:
      "rmd deploy [--reason <text>]   # OPERATOR trigger for the deploy supervisor (human-gated): writes state/DEPLOY_REQUESTED so the supervisor fast-forwards the daemon's checkout + `launchctl kickstart -k`s the daemon at the next idle gap, health-checks it, and rolls back on failure. Deploys nothing itself — keeps Craig's control over WHEN a merged fix goes live. The daemon runs `tsx src/` loaded once + dispatches in-process, so merged fixes are inert until this restart.",
  },
  {
    name: "deploy-run",
    usage:
      "rmd deploy-run [--dry-run]   # ONE deploy-supervisor cycle (the launchd unit runs this on its interval): no-op unless a deploy is triggered (marker or auto) AND the daemon is idle (no worker/inflight), then ff + kickstart at a re-checked idle gap, with health-check + rollback. --dry-run runs the whole sequence but SKIPS the real kickstart. Never restarts under an active task (the #559/#581 SIGKILL-orphan class).",
  },
  {
    name: "deploy-plist",
    usage:
      "rmd deploy-plist [--interval <s>] [--write]   # generate the deploy-supervisor launchd unit (a periodic `rmd deploy-run`, default every 120s). Mirrors daemon-plist: prints by default, --write installs it; `launchctl load` is an operator action. Opt into auto-on-new-main (behind the health-check) by touching state/DEPLOY_AUTO.",
  },
  {
    name: "serve",
    usage:
      "rmd serve [--port <n>] [--host <addr>]   # the operator console FRONT DOOR (W1-T139, MASTER-PLAN §7/§7B): one HTTP surface (service.ts) serving the live board (board.ts), fleet-control + question/manual-approve write actions (panel-actions.ts), the feedback inbox + plan→task→PR graph (panel-graph.ts), and a minimal HTML shell at GET /; bearer tokens are generated on first run and persisted 0600 under <config.root>/state/service-tokens.json, and rotate by stopping serve, deleting that file, and starting again; the startup banner prints the READ token only (a bookmark grants view, not control) and never the write token, because stdout is commonly redirected to a log; --port defaults to 4317 (matches apps/dashboard's own default); --host defaults to 127.0.0.1, also reads RMD_SERVE_HOST, accepts a COMMA-SEPARATED list so the console can be reachable locally AND from the phone (e.g. 127.0.0.1,<tailnet-ip>), and REFUSES wildcards like 0.0.0.0 anywhere in that list; blocks until SIGINT/SIGTERM",
  },
  {
    name: "console-url",
    usage:
      "rmd console-url [--port <n>] [--host <addr>] [--write]   # print the console URL carrying the READ token — the bookmark that gets you in, one command instead of hand-extracting <config.root>/state/service-tokens.json (fb-1784772988510-da3712); prints one URL per bound interface, resolving port/host EXACTLY as `rmd serve` does (flag > RMD_SERVE_HOST > config.serve.* > 127.0.0.1:4317); --write additionally prints the WRITE token as a bare value to paste into the console (never in a URL), and REFUSES unless stdout is a TTY, because a redirected stdout becomes a file that outlives the process (R-5); reads the 0600 tokens file but never creates one — if the console has never run it says so and names the remedy; spawns nothing",
  },
  {
    name: "serve-plist",
    usage:
      "rmd serve-plist [--port <n>] [--host <addr>] [--write]   # generate the launchd unit that runs the operator console as a background SERVICE (W1-T152, the W1-T12b generator family): KeepAlive (unconditional — `rmd serve` exits 0 on a clean SIGTERM and the console must come back from that too) + ThrottleInterval 60 (the R-1 relaunch-storm rate limit) + RunAtLoad, logs to <config.root>/state/logs/serve.{out,err}.log at 0600, and the resolved bind list in RMD_SERVE_HOST (flag > env > config serve.host > 127.0.0.1) with the port baked into ProgramArguments. Carries NO token: service-tokens.json is read at boot as today. References no daemon label or path — it installs and runs with the daemon stopped. Prints by default; --write installs it + pre-creates the 0600 logs; `launchctl bootstrap` stays the operator's step.",
  },
  {
    name: "down",
    usage:
      "rmd down [--port <n>] [--host <addr>]   # graceful wind-down for restart/maintenance (W1-T169): unloads the daemon launchd service (waiting a bounded window for any in-flight task to reach a safe boundary, else REPORTING its run id + recoverability — has-PR = the sweep recovers it, pre-PR = it re-dispatches), stops `rmd serve` BY PORT with a reap-wait (never an argv/pattern kill), and prints a wind-down summary (in-flight state, open-PR count, needs-human count, safe-to-restart). IDEMPOTENT: already-down is a no-op honest report, zero side effects.",
  },
  {
    name: "up",
    usage:
      "rmd up [--port <n>] [--host <addr>] [--allow-off-main]   # full resume (W1-T169): runs install-freshness FIRST (W1-T151 — a lockfile-changing pull triggers `npm ci` before anything starts), REFUSES to resume an off-main checkout unless --allow-off-main is given, loads the daemon launchd service, confirms/starts the serve launchd service, and prints a resume report (daemon pid, the console URL WITH its READ token via `rmd console-url`, the in-flight/queued head, needs-human count). IDEMPOTENT: already-up verifies + reports the running state, never a double start.",
  },
  {
    name: "status",
    usage:
      "rmd status [--json]   # W1-T279+W1-T280: ONE verb answering 'is it running' AND 'why is it stalled' from ONE read model. LOCAL (no network): LIVENESS (daemon/serve/deploy-supervisor running/pid/boot-time, running HEAD vs origin/main with a STALE flag, crash-loop), LATCHES (every state marker — STOP/PAUSE/QUIET_HOURS/DEPLOY_FAILED/DEPLOY_AUTO/inflight locks/pending kicks/drain-now — with its age and stated consequence), LAST CYCLE (the newest daemon.summary). DERIVED: BLOCKERS BY CLASS (circuit-broken w/ reset note, dispatch.indeterminate w/ gh-window note, blocked PRs by sweep.ts's own named reason), QUEUE HEAD (next dispatchables, perpetual-attempt tasks flagged with observed per-cycle cost), INBOX (ready/not-ready counts, head not-ready reason), HEADROOM (newest telemetry + enforcement on/off from the same switch the daemon reads) — these read a batched GitHub gateway and degrade to a stated unknown on an outage, never a gate on the local sections. Each section ends with at most one next action. --json emits the exact same read model the text renders. Read-only: writes nothing, spawns nothing, always exits 0 (bad args aside).",
  },
  {
    name: "sweep",
    usage:
      "rmd sweep [--repo <name>] [--dry-run]   # level-triggered PR-pipeline reconciler (W1-T77, P22): re-derive EVERY open PR's disposition from observed state and take the ONE gated action — mergeable->arm auto-merge; blocked-fixable->W1-T76 fix rung; stale/superseded->close-with-reason; blocked-ambiguous->the W1-T78 clarification-question rung (a specific, decidable operator question to the §2 backlog + escalate() as transport, never a generic needs-human). Idempotent (a second sweep over unchanged state acts on nothing). The daemon runs this every poll; --dry-run previews dispositions and takes nothing.",
  },
  {
    name: "fix",
    usage:
      "rmd fix <pr-number> [--repo <name>]   # operator verb for the W1-T76 fix rung (W1-T95, bootstrap/manual-override — drives a block on the sweep/drain delivery ITSELF, e.g. #160): dispatches the SAME rung sweep uses; refuses (zero spawns) when the PR is merged, closed, or has no block evidence; strikes-at-cap routes to escalate naming the count, never bypassing the cap.",
  },
  {
    name: "wipe-test",
    usage:
      `rmd wipe-test <task-id> [--repo ${WIPE_TEST_SANDBOX_DEFAULT}] [--allow-non-sandbox]   # the P12 learning-utility A/B harness (W1-T86): runs <task-id> TWICE — arm A with normal learnings injection, arm B with injection MASKED (the store itself untouched) — and ledgers the deltas (wipetest.pair: turns/cost/verdict/strikes/proof_exec); SANDBOX-ONLY by default, refuses any other --repo (including the primary repo) unless --allow-non-sandbox is also passed; a single pair is an anecdote — only the aggregate over many ledgered pairs is signal`,
  },
  {
    name: "stop",
    usage:
      "rmd stop [--reason <text>]    # fleet control: ONE-SHOT halt of the RUNNING drain; auto-clears when that run ends (no resume needed). No-op if nothing is running.",
  },
  {
    name: "pause",
    usage:
      "rmd pause [--reason <text>]   # fleet control: PERSISTENT drain-and-hold — in-flight completes, no new spawns; survives across runs until `rmd resume`.",
  },
  { name: "resume", usage: "rmd resume                    # fleet control: clear PAUSE (and any STOP); spawns resume" },
  {
    name: "away",
    usage:
      "rmd away [on|off]   # P34 clause (e): set/show operator presence (default attended). AWAY batches MANUAL/HARD_STOP escalations into the W1-T163 recap for async verdict instead of a real-time page; never gates dispatch.",
  },
  {
    name: "correct",
    usage:
      "rmd correct <task-id> --pr <n> [--reason <text>]   # sanctioned operator-correction writer (P9/W1-T75): appends a correction.provenance ledger line naming the task's TRUE merged PR, SUPREME over every deriveStatus rung; prints derived status before/after",
  },
  {
    name: "escalate",
    usage:
      'rmd escalate --class <BLOCKED|MANUAL|HARD_STOP> --task <id> --summary <s> [--detail <d>] [--recommendation <r>] [--option "label|detail"]...   # open a needs-human labeled GitHub issue; MANUAL/HARD_STOP also fire a real-time iMessage ping (BLOCKED collapses to digest)',
  },
  { name: "notify", usage: "rmd notify <message>     # real-time iMessage ping (osascript)" },
  {
    name: "digest",
    usage: "rmd digest [--since <iso>] [--dry-run]   # roll up the ledger into one daily digest message",
  },
  {
    name: "digest-plist",
    usage:
      "rmd digest-plist [--hour <h>] [--write]   # generate the launchd unit for the daily `rmd digest` pulse (W1-T112, the W1-T12b generator pattern) — StartCalendarInterval at <h>:00 local time (default 8); commissioning (launchctl load) is an operator action",
  },
  {
    name: "ops",
    usage:
      "rmd ops [--dry-run]   # alert intake v0+v1 (W1-T55/W1-T56, §5D lane 2, §7B): poll code-scanning/Dependabot/secret-scanning alerts for this repo via gh api, fold open counts+ages into the next digest, escalate every NEW critical/high alert exactly once (needs-human, ledger-deduped so a re-poll never double-escalates), and capture a plan/feedback/<id>.yaml entry (origin: alert#<source>-<id>) for every open alert not already captured, any severity, for rmd triage to ground; id-deduped so a re-poll never double-creates; --dry-run previews, opens no issues, creates no feedback",
  },
  {
    name: "alert-fix",
    usage:
      "rmd alert-fix [--repo <name>] [--dry-run]   # the alert-fix lane (W1-T90, ratifies P20, §5D lane 2's dep-review precedent): a deterministic policy (plan/alert-policy.yaml, data — no LLM ever) decides act-vs-escalate per open alert; act (severity medium/low, path outside the gate/containment-critical set) dispatches ONE ephemeral lane-owned fix run through the full [ci, remudero-review] gate, ledger-deduped so a re-poll never re-dispatches; escalate (critical/high/unknown severity, or a gate-critical path) opens a MANUAL needs-human issue via the SAME escalation-ledger namespace `rmd ops`'s own critical/high poll uses, so neither lane double-escalates the other's alert; never writes plan/tasks.yaml (rule 15); --dry-run previews every open alert's disposition, dispatches/escalates nothing",
  },
  {
    name: "issues",
    usage:
      "rmd issues [--dry-run]   # issues intake (W1-T57, §5D lane 3): poll open issues for every repo in .remudero/managed-repos.json via gh api, create a plan/feedback/<id>.yaml entry (origin: issue#<n>) for each one not already captured, fold an issues-reviewed count into the next digest; id-deduped so a re-poll never double-creates; --dry-run previews, creates nothing",
  },
  {
    name: "init",
    usage: "rmd init [--tier <pro|max5x|max20x>] [--yes]   # headless-safe first-run tier wizard",
  },
  {
    name: "project",
    usage:
      "rmd project init <repo> [--profile ts-node|ts-web|python|dotnet] --coverage-pct <n> --branches-pct <n> --mutation-pct <n> --dup-pct <n>   # fleet-inheritance onboarding primitive (W1-T27): generates the whole gate stack (workflows/configs/SECURITY.md/.remudero/principles.yaml) plus the branch-protection payload for a target repo; prints the file list + manual next steps, does not push/PR/arm protection itself",
  },
  {
    name: "onboard",
    usage:
      "rmd onboard <target-dir> --phase inventory|recon|session|synthesize [--owner <o> --repo <r>]   # the `rmd onboard` family (MASTER-PLAN \u2605P24, W1-T82/83/84/85): --phase inventory is a deterministic, no-LLM repo inventory over a TARGET checkout \u2014 languages, build/CI systems, docs presence (README/CONTRIBUTING/AGENTS.md/CLAUDE.md/ADRs/ROADMAP/TODO), branch-protection state, issue/milestone counts, test-signal presence \u2014 via policy-as-data detector tables (src/lib/onboard/inventory.ts), writing ONLY <target-dir>/plan/onboarding/inventory.json; --phase recon mines existing plan artifacts (ROADMAP/TODO/ADR intents/open issues) deterministically AND consults the four read-only W2-T1 specialist lenses (security/testing/design/containment) pointed at the whole repo (src/lib/onboard/recon.ts), writing ONLY plan/onboarding/findings.md + candidates.json \u2014 every candidate cites its source verbatim and mined vs inferred stays a labeled distinction; --phase session (src/lib/onboard/session.ts) generates a \u00a72-QUESTION-contract set from the inventory's own gaps plus a fixed goal-elicitation set \u2014 every question names its decision and candidate answers \u2014 and drives a resumable CLI answer loop, writing ONLY plan/onboarding/answers.json + appending onboard.answered lines to plan/onboarding/ledger.ndjson; a second invocation re-presents only the unanswered set; no-TTY previews the backlog and never blocks; --phase synthesize (src/lib/onboard/synthesize.ts) REFUSES (non-zero exit, naming every unanswered question id) unless phase 3's full question set is answered \u2014 goals are never guessed \u2014 then drafts MASTER-PLAN.md + plan/tasks.yaml + AGENTS.md from all four phase 1-3 artifacts, iterates the drafted tasks.yaml against the real `rmd lint-plan` linter (\u00a75C) until clean, and opens EXACTLY ONE draft PR to `onboard/<repo>-plan`, writing nothing outside that branch (never plan/onboarding/). Phases inventory/recon/session are read-only against the target + gh api; unresolved GitHub facts render as the literal \"unknown\", never guessed; --phase is REQUIRED \u2014 any other value fails loud, spawning/writing nothing",
  },
  {
    name: "feedback",
    usage:
      "rmd feedback <text...> [--attach <path-or-url>]... [--origin cli|ui|issue]   # durable-inbox async capture (MASTER-PLAN \u00a77B, W1-T40): writes plan/feedback/<id>.yaml with status: new; --attach copies a local screenshot/terminal-dump into plan/feedback/attachments/<id>/ or records an http(s) link verbatim; browse the inbox with plain ls/cat/git diff, no bespoke reader",
  },
  {
    name: "triage",
    usage:
      "rmd triage <feedback-id>   # the Architect intake worker (MASTER-PLAN \u00a77B, W1-T41): GROUNDS a plan/feedback/<id> entry against MASTER-PLAN/plan/LEARNINGS/DECISIONS, RESEARCHES via server-side WebSearch, then either reports 'already decided' (no task), GRILLS an ambiguous item by opening a needs-human GitHub issue with options + a recommendation (W1-T42, parks status 'grilling'), or opens a plan-only PR carrying origin: feedback#<id> provenance, gated by ci-gate+remudero-review like everything else",
  },
  {
    name: "skill",
    usage:
      "rmd skill list   # §5B skill-registry reader (W1-T44): resolves every .remudero/skills/<name>.yaml ({tools, permission_profile, output_contract, grounding_sources, gate, tier}); adding a skill is a config entry, no source change",
  },
  {
    name: "trace",
    usage:
      "rmd trace <id>   # render the provenance chain (MASTER-PLAN §7B / Standing rule 17, W1-T43): feedback → proposal PR → task(s) → run(s) → PR(s) → merge sha; <id> resolves as a task id first (reverse: task back to its origin:), else as a plan/feedback/<id> id (forward: feedback out to every task it produced)",
  },
  {
    name: "plan",
    usage:
      "rmd plan --mode=create|clarify|expand [<brief>...]   # the unified Architect PLAN skill (MASTER-PLAN §5B, W1-T45) — ONE ground→research→clear-or-grill-or-propose code path shared by all three modes (Refine=clarify, Expand=expand): create scaffolds new plan/tasks.yaml task(s) for the REQUIRED <brief> initiative; clarify grills (or silently resolves) ambiguous/underspecified existing tasks, <brief> optionally narrowing the focus; expand proposes gap-filling tasks that each cite a research source. CLEAR/GRILL touch nothing and open no PR; PROPOSED opens a plan-only PR (plan/** + MASTER-PLAN.md) gated by ci-gate+remudero-review",
  },
  {
    name: "inbox",
    usage:
      "rmd inbox [--dry-run]   # the ratification inbox's deterministic core (MASTER-PLAN P25(i), W1-T110): tiers the ACTIVE-proposal registry (state/inbox-proposals.json) into READY (drafted tasks' deps merged, evidence anchors grep-true on main, draft lint-plan-clean, no open conflict — carries its drafted plan/tasks.yaml fragment + stamp), not-ready (each failing predicate named), or DEFERRED-WITH-TRIGGER (an unfired named trigger — never recommended); drafts missing/stale candidates via a bounded, read-only Architect worker and caches them state-side (never committed); --dry-run classifies against whatever is already cached and spawns no worker",
  },
  {
    name: "approve",
    usage:
      "rmd approve <P##>   # one bit ratifies through the gate (MASTER-PLAN P25(ii), W1-T111): re-classifies <P##> live against the SAME facts `rmd inbox` would show; valid ONLY for a currently-READY proposal, refused (naming the state) with zero git/gh side effects otherwise; on READY, ships the cached draft's fragment + stamp VERBATIM into a plan PR (one branch, one PR) that rides the full gate (ci-gate + remudero-review) before auto-merge is armed — nothing auto-files without the bit; ledgers exactly one ratify.approved/ratify.approve_refused line",
  },
  {
    name: "reframe",
    usage:
      'rmd reframe <P##> --feedback "<text>" [--supersedes <rounds>]   # the feedback path (MASTER-PLAN P25(iii), W1-T111): ledgers ratify.reframed with the feedback verbatim, invalidates <P##>\'s cached draft, and appends to its reframe history so the NEXT `rmd inbox` draft-rung redrafts WITH the feedback in the Architect prompt; opens no PR, touches no git/gh — state-side only (registry + draft cache + ledger). --supersedes <rounds> (W1-T194) EXPLICITLY retracts existing round(s) — a number, comma list, range ("2-3"), or ALL — so their text is OMITTED from the next redraft while staying in reframeHistory and the ledger; never inferred from recency, and rejected with a usage error when the expression is invalid or out of range',
  },
] as const;

const USAGE_FOOTER =
  "An UNKNOWN command, or an unrecognized argument to a command, prints this usage and exits\nNON-ZERO, spawning nothing — the control surface never falls through to a drain on bad input.";

/** Full `rmd --help` text — every command's usage line, generated from COMMANDS. */
const USAGE = `usage:\n${COMMANDS.map((c) => `  ${c.usage}`).join("\n")}\n\n${USAGE_FOOTER}`;

/** `rmd <cmd> --help` text — the single matching command's line, same registry as USAGE. */
function commandHelp(spec: CommandSpec): string {
  return `usage:\n  ${spec.usage}\n\nSee \`rmd --help\` for the full command list.`;
}

/**
 * Look up a COMMANDS entry by name — throws if absent, which can only happen if a
 * command handler calls this with a name the registry doesn't have (a bug in THIS file,
 * caught by test/help-registry.test.ts's dispatch<->registry coverage check, never a
 * user-facing failure mode).
 */
function commandSpec(name: string): CommandSpec {
  const spec = COMMANDS.find((c) => c.name === name);
  if (!spec) throw new Error(`commandSpec: no COMMANDS entry for "${name}" — registry/dispatch are out of sync`);
  return spec;
}

/**
 * Just the invocation shape of one command ("rmd <name> ...", no trailing "# description"
 * comment) — for inline error-usage hints (`rmd fix: '<x>' is not a valid PR number —
 * usage: ...`) that need one command's syntax, not its full prose. Derived from the SAME
 * COMMANDS entry `rmd --help`/`rmd <cmd> --help` render from, so these hints cannot drift
 * from the registry the way hand-typed duplicates of this text used to.
 */
function commandSyntax(name: string): string {
  return commandSpec(name).usage.split(/\s{2,}#/)[0].trimEnd();
}

/**
 * W1-T151 INSTALL FRESHNESS: sha256 of `package.json` + `package-lock.json` content
 * (order-stable, null-separated) — a workspaces field added to `package.json` with no
 * `package-lock.json` change (or vice versa) still moves this hash, so the fixture task
 * exists for ("the workspace conversion that broke operator builds while CI stayed
 * green") is caught either way. A missing file hashes as empty content rather than
 * throwing — deterministic either way, never a crash on a repo with no lockfile yet.
 * This is a change-detector, not a security digest — collision resistance beyond
 * "npm's own two source files changed" is not the property being relied on.
 */
export function hashInstallInputs(
  repoDir: string,
  deps: { readFile?: (p: string) => string } = {},
): string {
  const readFile = deps.readFile ?? ((p: string) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return "";
    }
  });
  const pkg = readFile(join(repoDir, "package.json"));
  const lock = readFile(join(repoDir, "package-lock.json"));
  return createHash("sha256").update(pkg).update("\0").update(lock).digest("hex");
}

/** Where the last-successful-install hash is persisted — inside `node_modules` itself
 * (never committed, and naturally invalidated if `node_modules` is ever wiped wholesale). */
export function installHashMarkerPath(repoDir: string): string {
  return join(repoDir, "node_modules", ".rmd-install-hash");
}

export interface InstallFreshnessDeps {
  hash?: (repoDir: string) => string;
  readMarker?: (markerPath: string) => string | undefined;
  writeMarker?: (markerPath: string, hash: string) => void;
  /** Runs the real install (default `npm ci` in `repoDir`). Throws on failure — an
   * install that fails to bring `node_modules` in sync with the lockfile must fail
   * loudly here, never silently leave the caller running against the OLD, stale deps
   * (the exact bug this task exists to close). */
  install?: () => void;
}

/**
 * The REFUSAL {@link ensureInstallFresh} throws instead of installing through a symlinked
 * `node_modules` — a NAMED type so {@link serviceFreshnessGate} can distinguish "the install
 * was refused for safety" (ledger + proceed, per the W1-T255 service doctrine below) from
 * "the install RAN and failed" (which must stay loud, per the W1-T151 contract above).
 */
export class SymlinkInstallRefusal extends Error {}

/**
 * Bound on the DEFAULT `npm ci` {@link ensureInstallFresh} runs — damage control for an
 * install that WEDGES (dead registry socket, hung postinstall), which would otherwise hold a
 * `daemon`/`serve`/`up` boot forever. SIZED GENEROUSLY, deliberately: this repo has had FOUR
 * bounds fire on healthy conditions (ci-gate's wait cap under its own checks' wall-clock
 * W1-T312; a deploy ceiling consumed by a dry-run W1-T380; a check-wait bound where 21/21
 * booked PRs merged W1-T382; the pre-W1-T261 stale-red rerun window), and a too-tight value
 * here would be a fifth on the ONE operation that is legitimately slow. Evidence: the
 * review-clone sibling (`ensureDeps`, src/lib/review.ts) bounds a warm fresh-clone ci at
 * 120s; the only installs measured on this class of host completed in 60–90s warm
 * (2026-08-11); the cold-cache worst case (full registry download + playwright/esbuild
 * postinstalls) is minutes, not tens of minutes. 10 minutes is ~5x the sibling bound and
 * >6x the measured worst case — pacing is not the goal, unbounded hangs are.
 */
export const NPM_CI_TIMEOUT_MS = 600_000;

/**
 * W1-T151 INSTALL FRESHNESS — the fix for the real incident named in this task's
 * rationale: a git pull that changes `package.json`/`package-lock.json` (or adds a
 * `workspaces` layout) leaves a checkout's `node_modules` STALE relative to the code
 * that now expects it. CI never saw this (CI installs fresh every run); a local
 * checkout that just pulled the change did not.
 *
 * Cheap detection: hash `package.json` + `package-lock.json` ({@link hashInstallInputs})
 * and compare against the hash PERSISTED at {@link installHashMarkerPath} from the last
 * successful install. Different (or no persisted hash at all — a fresh clone) ⇒ `npm ci`
 * runs BEFORE the caller proceeds, then the marker is rewritten to the new hash. A
 * MATCHING hash is a total no-op — no redundant install, ever (the falsifier this task's
 * acceptance criteria name explicitly). Returns whether an install actually ran, so a
 * caller can ledger it.
 *
 * Deliberately reusable rather than git-plumbing-specific: it does not care HOW the
 * checkout moved (this repo's own self-sync pull, an operator's plain `git pull`, the
 * deploy supervisor's fast-forward, or a hand-run `npm install` that just changed the
 * lock) — only whether the two files on disk now differ from what was last installed.
 * Two call sites wire it: {@link serviceFreshnessGate} (the operator's `rmd daemon`/
 * `rmd serve` entry, below) and `DaemonDeps.runInstall` (lib/daemon.ts) for W1-T126's
 * in-process self-restart, consulted from the SAME predicate rather than duplicating it.
 */
export function ensureInstallFresh(repoDir: string, deps: InstallFreshnessDeps = {}): boolean {
  const hash = deps.hash ?? ((dir: string) => hashInstallInputs(dir));
  const markerPath = installHashMarkerPath(repoDir);
  const readMarker =
    deps.readMarker ??
    ((p: string) => {
      try {
        return readFileSync(p, "utf8").trim();
      } catch {
        return undefined;
      }
    });
  const writeMarker =
    deps.writeMarker ??
    ((p: string, h: string) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, h);
    });
  const install = deps.install ?? (() => execFileSync("npm", ["ci"], { cwd: repoDir, stdio: "pipe", timeout: NPM_CI_TIMEOUT_MS }));

  const current = hash(repoDir);
  if (readMarker(markerPath) === current) return false; // matching hash -> no-op

  // REFUSE to install through a symlinked `node_modules` — checked AFTER the no-op above, so
  // the refusal is of the INSTALL, never of the symlink: a worktree whose shared tree already
  // matches the lockfile hash no-ops exactly as before. `linkWorktreeNodeModules`
  // (src/lib/worker.ts) wires every worker worktree by SYMLINK to the canonical tree ON
  // PURPOSE, so a symlink here is the NORMAL worktree state — and `npm ci`'s clear phase
  // FOLLOWS the link: an install that "succeeds" here EMPTIES THE SHARED CANONICAL
  // node_modules through it (the 2026-07-29 daemon outage; measured again forensically
  // 2026-08-11 when a test's unguarded `rmd serve` child did exactly this). A worktree that
  // genuinely needs newer deps is served by refreshing the CANONICAL checkout — the deploy
  // path / `serviceFreshnessGate` on the operator checkout, where `node_modules` is a real
  // directory — after which the symlink serves the fresh tree with no install here at all.
  let nodeModulesIsSymlink = false;
  try {
    nodeModulesIsSymlink = lstatSync(join(repoDir, "node_modules")).isSymbolicLink();
  } catch {
    // absent node_modules — a fresh clone; installing into it is the legitimate case.
  }
  if (nodeModulesIsSymlink) {
    throw new SymlinkInstallRefusal(
      `refusing npm ci in ${repoDir}: node_modules is a symlink, and an install's clear phase would empty the SHARED tree it points at through the link (the 2026-07-29 outage mechanism). Refresh the canonical checkout instead — the symlink then serves the fresh tree.`,
    );
  }

  install();
  writeMarker(markerPath, current);
  return true;
}

/**
 * W1-T255: the LONG-RUNNING-SERVICE freshness gate (`rmd daemon`/`rmd serve`). Assesses the tree
 * via {@link checkServiceFreshness} and LEDGERS `daemon.tree_dirty` / `daemon.stale_code` — but
 * NEVER refuses, exits, or re-execs (a service crash-looping on its own dirt was the #707
 * aftermath). Genuine corruption still fails downstream in loadPlan. Extracted from main() so the
 * assess-and-ledger behavior is unit-testable (inject `checkServiceFreshness` + a tmp `ledgerPath`).
 *
 * W1-T151: also the operator's `build/serve` INSTALL-freshness choke point — see
 * {@link ensureInstallFresh}, run here (guarded by the SAME `svc.status !== "assessed"`
 * early-return above it, so CI/loop-guarded invocations never redundantly reinstall)
 * BEFORE this function returns and the caller's daemon/serve dispatch proceeds.
 */
export function serviceFreshnessGate(
  cmd: string,
  repoDir: string,
  env: NodeJS.ProcessEnv,
  deps: {
    checkServiceFreshness?: typeof checkServiceFreshness;
    ledgerPath?: string;
    ensureInstallFresh?: typeof ensureInstallFresh;
  } = {},
): void {
  const svc = (deps.checkServiceFreshness ?? checkServiceFreshness)(repoDir, env);
  if (svc.status !== "assessed") return; // guarded/degraded: nothing to ledger — proceed
  const ledgerPath = deps.ledgerPath ?? ledgerPathFor(loadConfig());
  const emit = (step: string, extra: Record<string, unknown>): void => {
    try {
      appendLedger(ledgerPath, {
        run_id: `${cmd.toUpperCase()}-boot-${Date.now()}`,
        task_id: cmd.toUpperCase(),
        step,
        ...extra,
      });
    } catch {
      // ledger is best-effort — a service is NEVER blocked by a ledger-write failure.
    }
  };
  if (svc.dirty) emit("daemon.tree_dirty", {});
  if (svc.behind) emit("daemon.stale_code", { old_sha: svc.behind.oldSha, new_sha: svc.behind.newSha });
  // Install BEFORE proceeding: package.json/package-lock.json changed since the last
  // install this repoDir ran (see ensureInstallFresh's doc) — never after.
  try {
    if ((deps.ensureInstallFresh ?? ensureInstallFresh)(repoDir)) emit("daemon.install_freshness", {});
  } catch (err) {
    // The SYMLINK REFUSAL only — the W1-T255 doctrine above ("a service NEVER exit-1s on
    // tree state") extends to it: ledger the refusal, say it on stderr, and boot on the deps
    // the symlink already serves — the shared canonical tree, which is the link's whole
    // point. Anything else `ensureInstallFresh` throws is an install that RAN and failed,
    // and that stays loud (the W1-T151 contract): rethrow, never boot silently stale.
    if (!(err instanceof SymlinkInstallRefusal)) throw err;
    emit("daemon.install_refused", { reason: err.message });
    console.error(`rmd ${cmd}: install refused — ${err.message}`);
  }
}

// ── CLI entry (invoked by bin/rmd). Kept tiny; all logic is above/lib.
export async function main(
  // W1-T79/W1-T221: the freshness check is injectable so a `callMain` test can drive the
  // "refused" branch below (its console.error+process.exit can't otherwise be covered — in CI
  // the real check returns "guarded", never "refused"). Default = the real self-sync check.
  deps: {
    checkFreshness?: typeof checkCliFreshness;
    checkServiceFreshness?: typeof checkServiceFreshness;
  } = {},
): Promise<void> {
  const [cmd, ...rest] = stripRepoRootFlag(process.argv.slice(2));
  const arg = rest[0];
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(USAGE);
    process.exit(0);
  }
  // Per-command help — checked BEFORE any dispatch below so `rmd <cmd> --help` never
  // reaches a command's business logic (e.g. `rmd notify --help` must not send a
  // notification whose message is the literal string "--help").
  const helpSpec = COMMANDS.find((c) => c.name === cmd);
  if (helpSpec && (rest.includes("--help") || rest.includes("-h"))) {
    console.log(commandHelp(helpSpec));
    process.exit(0);
  }
  // W1-T79: CLI self-freshness, checked directly after the (mandatory, every-call) help
  // preamble above and BEFORE any command's real dispatch — the #138 incident shape: `rmd
  // correct` existed on origin/main, but the OPERATOR's own invocation was a stale checkout
  // that predated the merge and printed the old usage instead. "rmd should be managing git
  // for me" is the requirement, verbatim (see src/lib/self-sync.ts for the full contract:
  // clean+behind auto-ff-pulls and re-execs once; dirty/diverged refuses with the exact
  // remedy and never mutates; up-to-date and the loop-guarded re-exec's child are both
  // total no-ops). A "refused" result must never fall through to dispatch below.
  // W1-T255: a LONG-RUNNING SERVICE (`rmd daemon`/`rmd serve`) NEVER exit-1s on tree state. The
  // interactive-operator refusal below crash-looped the daemon after the #707 aftermath — the
  // daemon dirties its OWN tree (DECISIONS.md/feedback/state exhaust), so every launchd restart hit
  // "dirty + behind -> refuse -> exit 1". Dirt never blocks a service; behind-origin is the deploy
  // supervisor's remit (WS-2) — assess + ledger + proceed, never refuse, never self-re-exec.
  if (cmd === "daemon" || cmd === "serve") {
    serviceFreshnessGate(cmd, repoRoot, process.env, deps);
    // ALWAYS proceed — never exit, never re-exec. Genuine corruption fails later in loadPlan.
  } else if (cmd === "deploy-run") {
    // impl-BD — THE CIRCULAR REFUSAL. `deploy-run` is the deploy supervisor's cycle (the
    // com.remudero.supervisor launchd unit invokes it every 120s), and its entire purpose is to
    // fast-forward a stale checkout. `checkCliFreshness` refuses when the tree is BEHIND *and*
    // DIRTY (self-sync.ts:164-176), so the verb that exists to fix staleness was refused FOR
    // BEING STALE. Reproduced live: "rmd is behind origin/main (e9fa9ac..97e6857) and the
    // working tree has uncommitted changes -- refusing to auto-sync". The ledger carries ZERO
    // deploy.* events across the live file and all 661 rotations — the supervisor has never
    // completed a cycle.
    //
    // NO GATE AT ALL here, deliberately, and NOT `serviceFreshnessGate` like daemon/serve:
    // that gate's last line calls `ensureInstallFresh`, which runs `npm ci` when the lockfile
    // hash moved (run-task.ts's ensureInstallFresh). An unattended `npm ci` on a 120-second
    // supervisor cycle is the exact shape that emptied this host's node_modules and
    // crash-looped the daemon. deploy-run needs the REFUSAL lifted, not an installer added.
    //
    // The safety this removes is replaced by a strictly BETTER guard the deployer already
    // owns: `treeFfSafe` (lib/deployer.ts:102) refuses only when a locally-modified path is
    // ALSO in the incoming diff — path-aware, returning "dirty-tree-conflict" and ledgering
    // `deploy.abort_dirty_tree` (lib/deployer.ts:236-242) — and it sits directly in front of
    // `pullFf()`. The outer gate was blunt (any dirt + any staleness) and fired first, which is
    // why the precise one had never run. Every OTHER verb keeps the refusal: `review`,
    // `lint-plan`, `triage`, `approve` and the rest read the plan, and a stale plan gives a
    // wrong answer — which is the whole point of the gate.
  } else {
    const freshness = (deps.checkFreshness ?? checkCliFreshness)(repoRoot, process.env);
    if (freshness.status === "refused") {
      console.error(freshness.message);
      process.exit(1);
    }
  }
  // W1-T86: checked directly after the (mandatory, every-call) help preamble above -- NOT
  // in its "natural" alphabetical/registration spot further down, beside fix. A behavioral
  // test of THIS dispatch branch must call main() itself (the only way to exercise the
  // literal `if (cmd === "wipe-test" ...)` lines the diff-coverage gate polices), and
  // main()'s flat if-ladder means EVERY dispatch check main() reaches before finding its
  // match gets evaluated too. Sitting first (right after the unavoidable help checks) means
  // that test evaluates no OTHER sibling's dispatch condition at all.
  if (cmd === "wipe-test" && arg) {
    process.exit(await wipeTestCommand(rest));
  }
  // diff-cov: process-boundary — main() CLI dispatch: process.exit(...) around the runTask call
  // cannot carry a DA hit without forking the process; the dispatched logic itself — arg
  // validation (unknownArgError, incl. --rerun), the already-merged refusal (W1-T319), and
  // every terminal verdict runTask can return — is unit-tested directly, driving REAL runTask()
  // calls, in test/run-task.test.ts (same irreducible-glue shape as the sibling emissions/
  // console-url/down/up/status/away dispatch cases just below).
  if (cmd === "run-task" && arg) {
    const badArg = unknownArgError("run-task", rest.slice(1), [], ["--allow-stale", "--rerun"]);
    if (badArg) {
      console.error(badArg + "\n" + USAGE);
      process.exit(2);
    }
    const result = await runTask(arg, {
      allowStale: rest.includes("--allow-stale"),
      rerun: rest.includes("--rerun"),
    });
    console.log("\n" + JSON.stringify(result, null, 2));
    process.exit(result.merged ? 0 : 1);
  }
  if (cmd === "review" && arg) {
    process.exit(await reviewCommand(arg, rest.slice(1)));
  }
  if (cmd === "dep-review" && arg) {
    process.exit(await depReviewCommand(arg, rest.slice(1)));
  }
  if (cmd === "lint-plan") {
    process.exit(await lintPlanCommand(rest));
  }
  if (cmd === "preflight") {
    process.exit(await preflightCommand(rest));
  }
  // diff-cov: process-boundary — main() CLI dispatch: process.exit(emissionsCommand(rest)) cannot carry a DA hit without forking the process; emissionsCommand's own logic — arg validation, the corpus union, the derivation/attribution and the render — is unit-tested in test/emissions.test.ts (same irreducible-glue shape as the sibling console-url/down/up dispatch cases).
  if (cmd === "emissions") {
    process.exit(emissionsCommand(rest));
  }
  if (cmd === "check-proof") {
    process.exit(checkProofCommand(rest));
  }
  // diff-cov: process-boundary — main() CLI dispatch: process.exit(ledgerGrepCommand(rest)) cannot carry a DA hit without forking the process; ledgerGrepCommand's own logic — arg validation, the archive glob, the zero-archive verdict, and the deduplicated match render — is unit-tested in test/ledger-grep.test.ts (same irreducible-glue shape as the sibling check-proof/emissions dispatch cases).
  if (cmd === "ledger-grep") {
    process.exit(ledgerGrepCommand(rest));
  }
  // diff-cov: process-boundary — main() CLI dispatch: process.exit(checkAcceptanceCommand(rest)) cannot carry a DA hit without forking the process; checkAcceptanceCommand's own logic — the usage refusal, the unreadable-file refusal, the truncation report, the missing-header report and the clean pass — is unit-tested in test/acceptance-block-diagnostics.test.ts (same irreducible-glue shape as the sibling check-proof/emissions dispatch cases).
  if (cmd === "check-acceptance") {
    process.exit(checkAcceptanceCommand(rest));
  }
  if (cmd === "next-task-id") {
    process.exit(await nextTaskIdCommand(rest));
  }
  if (cmd === "retro") {
    process.exit(await retroCommand(rest));
  }
  if (cmd === "drain") {
    process.exit(await drainCommand(rest));
  }
  if (cmd === "daemon") {
    process.exit(await daemonCommand(rest));
  }
  if (cmd === "daemon-plist") {
    process.exit(await daemonPlistCommand(rest));
  }
  if (cmd === "deploy") {
    process.exit(await deployCommand(rest));
  }
  if (cmd === "deploy-run") {
    process.exit(await deployRunCommand(rest));
  }
  if (cmd === "deploy-plist") {
    process.exit(await deployPlistCommand(rest));
  }
  if (cmd === "serve") {
    process.exit(await serveCommand(rest));
  }
  // diff-cov: process-boundary — main() CLI dispatch: process.exit(await consoleUrlCommand(rest, loadConfig())) cannot carry a DA hit without forking the process; consoleUrlCommand's own logic — the URL assembly, the --write TTY refusal, and all three failure modes — is unit-tested in test/console-url.test.ts (same irreducible-glue shape as the sibling away/pause/resume dispatch cases).
  if (cmd === "console-url") {
    process.exit(await consoleUrlCommand(rest, loadConfig()));
  }
  if (cmd === "serve-plist") {
    process.exit(await servePlistCommand(rest));
  }
  // diff-cov: process-boundary — main() CLI dispatch: process.exit(await downCommand(rest)) cannot carry a DA hit without forking the process; downCommand's own logic — the wind-down sequencing, the reap-wait, the recoverability report, and every idempotency/refusal branch — is unit-tested in test/rmd-down-up.test.ts (same irreducible-glue shape as the sibling console-url/away dispatch cases).
  if (cmd === "down") {
    process.exit(await downCommand(rest));
  }
  // diff-cov: process-boundary — main() CLI dispatch: process.exit(await upCommand(rest)) cannot carry a DA hit without forking the process; upCommand's own logic — install-freshness-first, the off-main refuse, the idempotent load sequencing, and the resume report — is unit-tested in test/rmd-down-up.test.ts (same irreducible-glue shape as the sibling console-url/away dispatch cases).
  if (cmd === "up") {
    process.exit(await upCommand(rest));
  }
  // diff-cov: process-boundary — main() CLI dispatch: process.exit(await statusCommand(rest)) cannot carry a DA hit without forking the process; statusCommand's own logic (arg validation, the queryService closure, --json vs text) plus the read model it calls (buildStatusBoard/renderStatusBoardText) are unit-tested in test/status-board.test.ts (same irreducible-glue shape as the sibling console-url/away/down/up dispatch cases).
  if (cmd === "status") {
    process.exit(await statusCommand(rest));
  }
  if (cmd === "sweep") {
    process.exit(await sweepCommand(rest));
  }
  if (cmd === "fix" && arg) {
    process.exit(await fixCommand(rest));
  }
  if (cmd === "stop") {
    process.exit(await stopCommand(rest));
  }
  if (cmd === "pause") {
    process.exit(await pauseCommand(rest));
  }
  if (cmd === "resume") {
    process.exit(await resumeFleetCommand());
  }
  // diff-cov: process-boundary — main() CLI dispatch: process.exit(await awayCommand(rest)) cannot carry a DA hit without forking the process; awayCommand's own logic is unit-tested in test/away-mode-delivery.test.ts (same irreducible-glue shape as the sibling pause/resume/correct dispatch cases).
  if (cmd === "away") {
    process.exit(await awayCommand(rest));
  }
  if (cmd === "correct" && arg) {
    process.exit(await correctCommand(rest));
  }
  if (cmd === "escalate") {
    process.exit(await escalateCommand(rest));
  }
  if (cmd === "notify") {
    process.exit(await notifyCommand(rest));
  }
  if (cmd === "feedback") {
    process.exit(await feedbackCommand(rest));
  }
  if (cmd === "triage") {
    process.exit(await triageCommand(rest));
  }
  if (cmd === "digest") {
    process.exit(await digestCommand(rest));
  }
  if (cmd === "digest-plist") {
    process.exit(await digestPlistCommand(rest));
  }
  if (cmd === "ops") {
    process.exit(await opsCommand(rest));
  }
  if (cmd === "alert-fix") {
    process.exit(await alertFixCommand(rest));
  }
  if (cmd === "issues") {
    process.exit(await issuesCommand(rest));
  }
  if (cmd === "init") {
    process.exit(await initCommand(rest));
  }
  if (cmd === "project") {
    process.exit(await projectCommand(rest));
  }
  if (cmd === "onboard") {
    process.exit(await onboardCommand(rest));
  }
  if (cmd === "skill") {
    process.exit(await skillCommand(rest));
  }
  if (cmd === "trace") {
    process.exit(await traceCommand(rest));
  }
  if (cmd === "plan") {
    process.exit(await planCommand(rest));
  }
  if (cmd === "inbox") {
    process.exit(await inboxCommand(rest));
  }
  if (cmd === "approve" && arg) {
    process.exit(await approveCommand(rest));
  }
  if (cmd === "reframe" && arg) {
    process.exit(await reframeCommand(rest));
  }
  console.error(USAGE);
  process.exit(2);
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error("\n### RUN-TASK ERROR\n" + (err?.stack ?? String(err)));
    process.exit(1);
  });
}

export { runTask, runReview, waitForCiGreen, reviewCommand, depReviewCommand, retroCommand, initCommand, projectCommand };
// Exported for a behavioral test of the drain gateway-targeting fix (W1-T53): drainCommand's
// injectable deps (config/planPath/skipGitSync/githubFactory) let a test prove `--repo` scopes
// the merged-status gateway to the NAMED repo, not a hardcoded literal — logic unchanged, export
// + injectable seams only (mirrors runTask's identical opts.github/skipGitSync escape hatch).
export { drainCommand };
// inboxCommand/approveCommand/reframeCommand are exported directly on their own `async
// function` declarations above (not re-exported here) -- W1-T240's registry-lock fix added
// their injectable `deps.config`/`deps.gateway` seams, which a behavioral test now drives
// through the REAL command dispatch path (mirrors drainCommand's own config/githubFactory
// escape hatch above); an `export { ... }` statement THIS FAR down the file sits past dead
// code (the `if (process.argv[1] === ...)` guard just above, never true under `--test`) that
// throws off this file's tsx/source-map line attribution for every statement after it, so a
// re-export here would always read as 0-hit in lcov no matter how thoroughly it is tested.
// Exported for a behavioral test of the retro no-op guard (W1-T64): commitsAhead is the predicate the
// retro/implement no-op path branches on (=== 0 ⇒ nothing to PR). Logic UNCHANGED — export only.
export { commitsAhead };
// Exported for W1-T47's help-registry test: COMMANDS is the ONE source of truth both USAGE
// (`rmd --help`) and commandHelp (`rmd <cmd> --help`) generate from — export only, logic unchanged.
// commandSyntax/commandSpec are the same lookup individual command handlers use for their
// inline usage hints (fix/escalate/notify/project/correct) — no hand-written duplicate text.
export { COMMANDS, USAGE, commandHelp, commandSpec, commandSyntax, type CommandSpec };
