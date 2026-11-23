/**
 * W1-T5689 — no NEW daemon-loop path reaches a synchronous spawn.
 *
 * A synchronous `execFileSync`/`spawnSync`/`execSync` (or the sync `ghExec`/`ghJson`, or a blocking
 * `Atomics.wait` sleep) called anywhere on the daemon loop's reach freezes the event loop for as long as
 * the child runs. Every stall so far (the 51 min of 2026-10-04, the 54 min review hang of 2026-10-03) was
 * fixed ONE SITE AT A TIME after it was measured live; test/gh-transport-census asks where `gh` is spawned,
 * not whether the loop can reach it. This census refuses the NEXT reachable site before it ships.
 *
 * Population: every top-level function (declaration, arrow const or, since W1-T9660, object-literal const) whose
 * code-only body (strings and comments blanked) calls a synchronous spawn primitive. Reach: the name-based fixed point of test/no-daemon-loop-path-builds-the-
 * unbatched-gateway, seeded from `daemonCommand` (its DaemonDeps literal and the hook builders). Baseline:
 * SYNC_SPAWN_LOOP_BASELINE, {functionName: count} recorded at build time. The census is EXACT, like the
 * hardened-leaf census: a reachable name ABSENT from the table or a count ABOVE its row fails, and so does a
 * count BELOW its row — a converter lowers that row (or deletes it at 0) in the same PR, so the table never
 * holds slack a later regression could silently refill (operator ruling 2026-10-10).
 */
// @source-text-subject: src/**/*.ts — the claim is a property of EVERY function the loop can reach,
// including paths no single execution drives; the same shape as test/gh-transport-census.
import assert from "node:assert/strict";
import { test } from "node:test";

import { codeOnly, factoryNames, loopCensusFunctions, loopReachable, MODULE_LOAD, splitObjectLiteral, topLevelFunctions, type Fn } from "./helpers/daemon-loop-walk.js";

/** Loop-reachable functions that still call a synchronous spawn primitive or hand one over as a value,
 *  with the count recorded at build time (2026-10-10, f49ee17d3; re-recorded the same day on e91d490f1
 *  when the handed-over form began to count). A new name, or a count above its row, fails the census;
 *  so does a count BELOW its row: converting a site lowers its row here (or deletes it at 0) in the same PR. */
const SYNC_SPAWN_LOOP_BASELINE: Readonly<Record<string, number>> = {
  applyGhReadCadence: 1,
  assertOpenWeightToolBoundary: 1,
  assertWorkerEgressEnforcerVersion: 1,
  authorBaseRef: 1,
  baseBranchRequiresMergeQueue: 1,
  blobShaAtRef: 1,
  blockingSleep: 1,
  buildBatchedGithub: 1,
  buildCommitTrailerIndex: 1,
  buildProofAmendmentWritePorts: 2,
  buildRegisteredGarden: 3,
  buildSweepEffects: 5, // Armed-idle direct merge now awaits its transport and security observation.
  buildWipeTestCadenceDaemonHooks: 1,
  changeView: 1,
  changedShardProofs: 2,
  checkCliFreshness: 1,
  checkProofAtAuthorTime: 1,
  ciLearningTaskIdMinter: 1,
  codeScanningJudgeDeps: 1,
  couldBeInterpolatedTitle: 1,
  createGhCallPacer: 1,
  createHeadRehomePorts: 1,
  createTickReadProducer: 1,
  creditEvidenceRootFor: 1,
  currentBranch: 1,
  daemonCommand: 4,
  daemonSreRunbookHost: 4,
  defaultAdoptionShipDate: 1,
  defaultBinaryPinDeps: 1,
  defaultBlockingSleepSync: 1,
  defaultBranchIsLiveUpstream: 1,
  defaultCanExecute: 1,
  defaultCiAnnotationFetch: 1,
  defaultCiJobLogFetch: 1,
  defaultCountBehind: 1,
  defaultCoverageArtifactGhBuffer: 1,
  defaultCoverageArtifactGhJson: 1,
  defaultDepReviewPrMutations: 2,
  defaultDirtyFleetRebaseGit: 1,
  defaultEmailSpawn: 1,
  defaultExec: 2,
  defaultExecutor: 1,
  defaultGetProcessStartTime: 1,
  defaultGh: 1,
  defaultGhExec: 2,
  defaultGit: 4,
  defaultGitCapture: 1,
  defaultInstallDependencies: 1,
  defaultIsInUse: 1,
  defaultLaneListGit: 1,
  defaultListCandidates: 1,
  defaultListProcesses: 1,
  defaultMeasurementCadenceGitLog: 2,
  defaultMergeEvidenceLog: 2,
  defaultOpenFileCount: 1,
  defaultOriginOf: 1,
  defaultPlanRepairGit: 1,
  defaultPreflightSpawn: 1,
  defaultProbeLiveGitProcess: 1,
  defaultProofRunner: 1,
  defaultPsGroupListing: 1,
  defaultPushExec: 2,
  defaultReadMarkers: 1,
  defaultReadRemoteHead: 1,
  defaultReadRemoteHeadSha: 1,
  defaultReconGhExec: 1,
  defaultRegistryLockSleep: 1,
  defaultRetroDiffText: 1,
  defaultRetroFetchBody: 1,
  defaultRevListCanonicalBehind: 1,
  defaultRunInstall: 1,
  defaultSecurityRunner: 1,
  defaultSizeBytes: 1,
  defaultSleepSyncMs: 1,
  defaultSweepGhRun: 1,
  defaultSynthesizeGhExec: 1,
  defaultSynthesizeGitExec: 1,
  defaultThrottleProbeRun: 1,
  defaultUpstreamGh: 1,
  defaultUpstreamGit: 1,
  defaultWhich: 1,
  defuseCandidates: 1,
  depReviewCommand: 3,
  discoverLiveLedgerRoot: 1,
  dispatchClaimReserverFor: 1,
  draftProposalBatch: 1,
  ensureDeps: 1,
  ensureInstallFresh: 1,
  ensureTaskTrailer: 2,
  ensureWorktreeConfigEnabled: 2,
  execGhPrReview: 1,
  execWhitelistedProof: 1,
  executeWorktreeRemoval: 1,
  extractReviewFindings: 1,
  fetchMergedCoverageArtifact: 4,
  fetchNewestPrReview: 1,
  fetchPrBodyViaGh: 1,
  fetchPrDiffFilesViaGh: 1,
  fetchPrLifecycle: 1,
  fileLine: 1,
  filingRef: 1,
  fixCommand: 1,
  fixRebaseMergeFactsFromRest: 2,
  fixRungCiFailures: 1,
  gardenCheckout: 3,
  ghAlertGateway: 1,
  ghEscalationAnswerGateway: 1,
  ghExec: 4,
  ghExecFile: 4,
  ghIssueGateway: 1,
  ghIssueListGateway: 1,
  ghJson: 2,
  ghLiveHead: 1,
  ghLiveState: 1,
  ghLiveStateByNumber: 1,
  ghPrHeadGateway: 1,
  ghPrMergeSquash: 1,
  ghPrView: 1,
  ghUpdateBranch: 2,
  git: 1,
  githubRepoOfCheckout: 1,
  gitFailureReason: 1,
  gitGrepAnchorTrue: 1,
  grepFilesContaining: 1,
  grepProofHeldAt: 1,
  grepProofHolds: 1,
  handedOffHeadRiskJudge: 1,
  hostWorktreeGit: 1,
  installPinnedChromium: 1,
  isPrMergedNow: 1,
  ladderGardenSpec: 1,
  listRegisteredWorktrees: 1,
  localBranchExists: 1,
  localMergeSpawn: 1,
  main: 5,
  mainRecords: 1,
  mainTrailerTaskIds: 1,
  manifestLastCommitMs: 1,
  materializeReviewerSnapshot: 1,
  mergeBaseFor: 1,
  mergeDirectViaRest: 1,
  mergeShaNow: 1,
  mergedTriageSubjects: 1,
  openPrFileScopes: 1,
  openPrMintTexts: 1,
  opportunityIntakePortsOver: 1,
  originUrlAtCut: 1,
  pinnedConfigValue: 1,
  planPrPreflightAtCommit: 1,
  planSafetyGitSync: 1,
  postReviewPending: 1,
  prepareDefuseTaskIds: 1,
  // W1-T9553 (operator yes, 2026-10-25): its sync ghExec runs in the evidence-coverage pass, which the daemon spawns
  // as an off-loop child; only the test-only gardenPassesInProcess seam reaches it by name.
  prepareEvidenceRecordContext: 1,
  probeProofSandbox: 1,
  productionGardenerOverseerPorts: 1,
  productionMachineFilingJudgePorts: 1,
  productionOpportunityOutcomePorts: 1,
  projectionGithub: 1,
  proofLandingCommit: 1,
  proofRepairRoundRefusalInWorktree: 1,
  pruneStaleRuns: 3,
  publishAbandonedFixOwnerAhead: 1,
  readAffectedListings: 1,
  readAffectedSuitesInput: 1,
  readCheckoutDepth: 2,
  readCiFrictionHandFixes: 2,
  readCiFrictionPlanState: 1,
  readCodeScanningAlerts: 1,
  readHeadShaRest: 2,
  readLadderPlan: 1,
  readLocalOriginRefHead: 1,
  readMainHistory: 1,
  readMergeSubjectsByPr: 1,
  readMergedPathsByPr: 1,
  readMutationVerdictZip: 1,
  readOperatorInterventions: 2,
  readOutcomes: 1,
  readRequiredStatusCheckContexts: 1,
  readTaskPrecondition: 1,
  readyDraftViaGh: 1,
  realArmDeps: 7, // +1 2026-10-11: the closing-reference guard reads the PR body before a sync arm (ghJson handed over); +1 W1-T9536: the sync own-files compare reader (realArmDepsAsync overrides it)
  realDeployDeps: 1,
  realReviewWorktree: 1,
  realSharedPauseGitDeps: 1,
  reapBranchesSteps: 1,
  redBaseRefreshFactsFromRest: 1,
  referencesOutside: 1,
  refreshKnowledgeAssertions: 2,
  refreshProofToolchain: 1,
  registeredFixWorktreeOwner: 1,
  remotePlanCeilingOnRef: 1,
  renumberPlanPrIds: 1,
  repairPrMetadata: 2,
  requeueActionsJobOutcome: 1,
  reservationBaselineIds: 1,
  reservationPolicyCurrency: 1,
  resolveClaudeBin: 1,
  resolveCodexBin: 1,
  resolveCommitAssignment: 1,
  resolveMergeLogReadOptions: 1,
  resolveOwnerRepoAt: 1,
  reviewCommandHost: 2,
  retroShippedGithubGateway: 1,
  reuseDonor: 1,
  reviewCommand: 1,
  reviewerCodeRecoveryFromLoadedModule: 1,
  run: 1,
  runCoverageImprovementCadence: 1,
  runGhPrCreate: 1,
  runInTree: 1, // W1-T9660: via defaultPreflightChecks; W1-T9695/W1-T9696/W1-T9734/W1-T9735 moved the boot sweep, daemon landContent, CI-learning, daemon feedback captures, decision records, alert status flips, fold debt and knowledge garden off it; by name only, the planPrPreflight option and the sweepFeedbackLanding dep
  runMachineFilingJudge: 1,
  runNpmScriptViaSpawn: 1,
  runPrewarmChannelsSync: 1,
  runReview: 1,
  runSuiteShifted: 1,
  runTaskBody: 2,
  runWipeTestPair: 1,
  serviceGit: 1,
  sleepSync: 3,
  sourceRepositoryFromCwd: 1,
  spawnPreparedProofSync: 1,
  sreOperatorEscalation: 1,
  stackPrerequisiteFromRest: 1,
  startCheckSync: 1,
  sweepPostFixReverification: 1,
  syncBoardReviewOpenPrs: 1,
  syncPlanFromOrigin: 2,
  taskIdDeclarationsAtRef: 1,
  taskIdOwnershipFindings: 1,
  taskIdsEverFiled: 1,
  testSlotProcessFacts: 1,
  triageCommandLocked: 2,
  vetPinnedConfig: 1,
  worktreeAdd: 5,
  worktreePushExec: 1,
  writePrBodyRest: 1,
};

/** W1-T12753 / W1-T13416: exact counts of synchronous ledger readers and zlib primitives
 *  called or handed over by loop-reachable functions, measured on efd1e7a710.
 *  A converter lowers its row in the same PR. */
const SYNC_LEDGER_SCAN_LOOP_BASELINE: Readonly<Record<string, number>> = {
  armIfVerdictPermitsAsync: 1,
  assertConfiguredMergeUnheld: 1,
  backlogGardenSpec: 1,
  buildBaseReproductionProbe: 1,
  buildCreditCandidates: 1,
  buildHeadroomRecoveryCandidates: 1,
  buildInboxDraftHook: 1,
  buildMainHealthRung: 6,
  buildQueueJudgeSources: 1,
  buildRedesignSources: 1,
  buildSweepEffects: 10,
  buildSweepLightHook: 2,
  claimLedgerText: 1,
  closeRecoveredEscalation: 1,
  compactWindow: 2,
  compareSnapshot: 1,
  computeBoardSnapshot: 1,
  costGovernorGateFor: 1,
  createIncrementalLedgerUnion: 2,
  createLedgerProjector: 1,
  createLiveLedgerTail: 3,
  createRepoLedgerIndex: 1,
  createTickReadProducer: 1,
  daemonBreakerRunbookHost: 1,
  daemonCommand: 3,
  daemonCrashSentinel: 2,
  daemonDefaultBuildSweepHook: 1,
  daemonEvidenceCoverageInput: 1,
  decompressedSizeOf: 1,
  depReviewCommand: 1,
  deriveStatus: 1,
  disposeDisarm: 1,
  escalateCircuitBreak: 1,
  escalateCrashLoop: 1,
  escalateDiskHeadroomBreach: 1,
  escalateHeadroomParkCeiling: 1,
  escalateHeadroomReserve: 1,
  escalatePostReviewStall: 1,
  escalateQuotaExhaustion: 1,
  escalateReplayStranded: 1,
  escalateStarvation: 1,
  escalateStarvationCleared: 1,
  evaluateDispatchBreakerDetailed: 1,
  fixCommand: 2,
  fixRoundClaimEnded: 1,
  flakeEvidence: 1,
  inboxCommand: 1,
  judgeDispatchBreak: 1,
  ledgerClassTier: 1,
  ledgerRotationDigests: 1,
  lightPassHeadContractRefresh: 1,
  memoryReadTrackerFor: 1,
  mergeAtListHead: 1,
  observeAdmissionFlow: 1,
  openPrViewSteps: 1,
  pollAlerts: 1,
  probeOpenPrMerges: 1,
  productionGardenerOverseerPorts: 2,
  productionIssueRevalidationPorts: 1,
  productionMachineFilingJudgePorts: 2,
  productionMechanicalPort: 2,
  productionOpportunityOutcomePorts: 1,
  projectPlan: 1,
  queueGovernorGateFor: 1,
  readBacklogLedgerRecords: 1,
  readCiFrictionLedgerRecords: 1,
  readConfigGardenLedgerRows: 1,
  readDocketLedgerCorpus: 1,
  readFixRoundArchiveRows: 1,
  readFlakeIncidentRows: 1,
  readFlowLedger: 2,
  readLadderRecords: 1,
  readLedgerUnionBounded: 2,
  readLedgerUnionRawLinesSync: 1,
  readLedgerUnionRecordsMemoized: 1,
  readLedgerUnionRecordsSync: 2,
  readLiveLedgerRecords: 1,
  readMeasuredLearningOutcomes: 1,
  readMergeCreditedTaskIds: 2,
  readMergeCreditedTaskIdsAsync: 1,
  readOnlyInspectionCommand: 1,
  readOperatorAgentUnion: 1,
  readRestartHistoryLines: 1,
  readReviewReplaySample: 1,
  readRunChildModeUnion: 1,
  readSelectorShadowObservations: 1,
  readTargetExecution: 1,
  realArchiveFs: 1,
  realArmDeps: 1,
  realFs: 2,
  realLedgerFs: 1,
  realLedgerKeyManifestFs: 1,
  reappendLostReviewPosted: 2,
  reapBranchesSteps: 1,
  receiptOrphanedAssignments: 1,
  recordRoutingExperimentResults: 1,
  recordWorkerProvidersAtStart: 1,
  registryThreadItems: 1,
  releaseBreaker: 1,
  reportSilentHostLocks: 1,
  resolveLedgerUnion: 1,
  reviewCommand: 1,
  rowsToRecarry: 1,
  runAlertLane: 1,
  runDaemon: 8,
  runDeploymentBakeoff: 1,
  runDigestCadenceReport: 1,
  runFixRung: 13,
  runPostFixReverification: 1,
  runReview: 1,
  runTaskBody: 2,
  runWipeTestPair: 2,
  runWorkerStallDetectorRung: 1,
  scoutGardenSpec: 1,
  settleRunChildBacklog: 1,
  stageSkillLifecycleForAction: 1,
  staleBodyFindingsForTick: 1,
  statusLedgerUnionFsDeps: 2,
  terminalKeysInArchives: 1,
  terminalUncreditableHeads: 1,
  triageClaimSweepForPass: 1,
  triageCommandLocked: 1,
  updatedForWorkflowFromLedger: 1,
  verifyStalledTask: 1,
  windowedRows: 1,
  withRequeueReceipts: 1,
  withdrawArmIfVerdictRefuses: 1,
  withheldReviewsSince: 1,
  writeArchive: 1,
  zipEntryData: 1,
  zipTextMembers: 1,
};

/** A synchronous spawn or block: the node primitives, the sync gh wrappers (`ghJsonAsync`/`ghExecAsync`
 *  do not match — the `(` must follow the name), the blocking sleep, and `Atomics.wait`. */
const SYNC_SPAWN_CALL =
  /\b(?:execFileSync|spawnSync|execSync|ghExec|ghExecFile|ghJson|defaultBlockingSleepSync)\(|\bAtomics\.wait\(/g;

/** The same primitives handed over as a VALUE: a seam's default (`exec = execFileSync`), a fallback
 *  (`deps.run ?? spawnSync`), an argument (`fetchOpenPrsRest(o, r, ghJson)`). The call then happens
 *  under a name {@link SYNC_SPAWN_CALL} cannot see. On 2026-10-10 `checkFixCensusSnapshot`
 *  (`run: typeof spawnSync = spawnSync`, up to 5.9 s) and `mergeDirectViaRest` (`= execFileSync`,
 *  2.7 s) held the daemon loop while this census counted both at zero. `typeof X`, a string and a
 *  comparison (`exec === execFileSync`) hand nothing over. */
const SYNC_SPAWN_VALUE =
  /(?:(?<![=!<>])=|\?\?|\|\||[(,:])\s*(?:execFileSync|spawnSync|execSync|ghExec|ghExecFile|ghJson|defaultBlockingSleepSync)(?![\w$])(?!\s*\()/g;

/** Calls and handed-over primitives in one body; the sleep's own definition is not a call site. */
function syncSpawnCalls(fn: Fn): number {
  const defines = /^(?:export\s+)?function\s+defaultBlockingSleepSync\(/.test(fn.body) ? 1 : 0;
  return (fn.body.match(SYNC_SPAWN_CALL) ?? []).length + (fn.body.match(SYNC_SPAWN_VALUE) ?? []).length - defines;
}

/** Synchronous-spawn calls per function NAME (same-named functions in different files sum). */
function population(fns: Fn[], count: (fn: Fn) => number = syncSpawnCalls): Map<string, number> {
  const pop = new Map<string, number>();
  for (const f of fns) {
    const n = count(f);
    if (n > 0) pop.set(f.name, (pop.get(f.name) ?? 0) + n);
  }
  return pop;
}

/** Whole-file or union readers and the synchronous zlib operations that can block the loop. */
const SYNC_LEDGER_SCAN_PRIMITIVES = [
  "readLedgerUnionRecordsSync",
  "ledgerRowsForSync",
  "readLedgerLines",
  "readLedgerUnionRawLinesSync",
  "gunzipSync|nodeGunzipSync|gzipSync|unzipSync",
  "(?:in|de)flate(?:Raw)?Sync",
  "(?:brotli|zstd)(?:Compress|Decompress)Sync",
].join("|");
const SYNC_LEDGER_SCAN_CALL = new RegExp(`(?<![\\w$])(?:${SYNC_LEDGER_SCAN_PRIMITIVES})\\s*\\(`, "g");
const SYNC_LEDGER_SCAN_DEFINITION =
  new RegExp(`^(?:export\\s+)?function\\s+(?:${SYNC_LEDGER_SCAN_PRIMITIVES})\\s*\\(`);
// Defaults, fallbacks, arguments, returns and object members can hand a primitive to a later caller.
const SYNC_LEDGER_SCAN_VALUE = new RegExp(
  `(?:(?<![=!<>])=|\\?\\?|\\|\\||[(,:\\[{]|\\breturn\\b)\\s*(?:[\\w$]+\\s*\\.\\s*)*` +
    `(?:${SYNC_LEDGER_SCAN_PRIMITIVES})(?![\\w$])(?!\\s*(?:[(:.]|\\?\\.|[!=]=))`,
  "g",
);

/** Count calls and handoffs in a code-only body. */
function syncScanCalls(fn: Fn): number {
  const defines = SYNC_LEDGER_SCAN_DEFINITION.test(fn.body) ? 1 : 0;
  return (fn.body.match(SYNC_LEDGER_SCAN_CALL) ?? []).length + (fn.body.match(SYNC_LEDGER_SCAN_VALUE) ?? []).length - defines;
}

/** One exact census: what it counts, the table it is held to, and how its refusals read. */
interface Census {
  count: (fn: Fn) => number;
  table: string;
  noun: string;
  remedy: string;
}

const SPAWN_CENSUS: Census = { count: syncSpawnCalls, table: "SYNC_SPAWN_LOOP_BASELINE", noun: "synchronous spawn call(s)", remedy: "await an async seam instead" };
const LEDGER_SCAN_CENSUS: Census = { count: syncScanCalls, table: "SYNC_LEDGER_SCAN_LOOP_BASELINE", noun: "synchronous ledger scan(s)", remedy: "await an async ledger reader instead" };

/** The file holding SYNC_SPAWN_LOOP_BASELINE, named in every shrink refusal so a converter knows where to edit. */
const BASELINE_FILE = "test/no-daemon-loop-path-reaches-a-synchronous-spawn.test.ts";

/** Every loop-reachable name whose count differs from its row, with both numbers. EXACT, like the
 *  hardened-leaf census (test/every-host-git-spawn-into-a-worktree-uses-the-hardened-leaf): growth is
 *  refused, and so is shrinkage until the row is lowered (or deleted at 0) in the same PR, so the table
 *  never holds slack a later regression could refill unseen. A row whose name the loop no longer reaches
 *  counts 0. */
function refusals(fns: Fn[], baseline: Readonly<Record<string, number>>, census: Census = SPAWN_CENSUS): string[] {
  const reach = loopReachable(fns, "daemonCommand");
  const pop = population(fns, census.count);
  const { table, noun, remedy } = census;
  const names = new Set([...pop.keys()].filter((n) => reach.has(n)));
  for (const n of Object.keys(baseline)) names.add(n);
  const out: string[] = [];
  for (const name of [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const count = reach.has(name) ? pop.get(name) ?? 0 : 0;
    const row = Object.hasOwn(baseline, name) ? baseline[name]! : undefined;
    if (row === undefined) {
      out.push(`${name} makes ${count} ${noun} and is reachable from the daemon loop (daemonCommand), but is not in ${table} — ${remedy}`);
    } else if (count > row) {
      out.push(`${name} makes ${count} ${noun} on the daemon loop, above its ${table} row of ${row} — ${remedy}`);
    } else if (count < row) {
      out.push(count === 0
        ? `${name} makes 0 ${noun} on the daemon loop < row ${row} — delete the \`${name}\` row from ${table} (${BASELINE_FILE}) in this PR`
        : `${name} makes ${count} ${noun} on the daemon loop < row ${row} — lower ${table} \`${name}\` to ${count} (${BASELINE_FILE}) in this PR`);
    }
  }
  return out;
}

/** W1-T12791: the functions repairPrMetadata's production plan reader runs, which must await the async git leaf. */
const MERGE_PLAN_READERS = ["planCriteriaAtMergeForRepair", "mergeCommitForRepair", "repairCheckoutTopLevel"] as const;
const SYNC_GIT_LEAF_CALL = /\bhostWorktreeGit(?:AtTopLevel|Result)?\(/g;

/** Each merge-plan reader that calls a synchronous spawn or the synchronous git leaf, named under repairPrMetadata. */
function mergePlanReadRefusals(fns: Fn[]): string[] {
  const out: string[] = [];
  for (const name of MERGE_PLAN_READERS) {
    const fn = fns.find((f) => f.name === name);
    if (fn === undefined) { out.push(`repairPrMetadata's plan reader ${name} is missing`); continue; }
    const count = (fn.body.match(SYNC_GIT_LEAF_CALL) ?? []).length + syncSpawnCalls(fn);
    if (count > 0) out.push(`repairPrMetadata's plan reader ${name} makes ${count} synchronous git call(s) — await hostWorktreeGitAsync instead`);
  }
  return out;
}

test("census: the seed and the population are real, so the walk cannot pass vacuously", () => {
  const fns = loopCensusFunctions();
  assert.ok(fns.some((f) => f.name === "daemonCommand"), "the walk must find daemonCommand to seed from");
  const pop = population(fns);
  const reach = loopReachable(fns, "daemonCommand");
  // Positive controls: a sync-spawning function the loop reaches, and a function the loop reaches whose
  // spawns W1-T5672 moved off the loop (it must stay REACHED so a regression there is named).
  assert.ok(pop.has("syncPlanFromOrigin") && reach.has("syncPlanFromOrigin"), "syncPlanFromOrigin is a reachable sync spawner");
  assert.ok(pop.has("defaultGit") && reach.has("defaultGit"), "defaultGit is a reachable sync spawner");
  assert.ok(reach.has("sweepLandingSteps"), "the loop reaches sweepLandingSteps");
  assert.ok(!pop.has("sweepLandingSteps"), "sweepLandingSteps awaits its network verbs (W1-T5672): no sync spawn of its own");
  assert.ok(pop.size > 100, `the scan must see the sync-spawning functions across src; saw ${pop.size}`);
});

test("unit test: test/no-daemon-loop-path-reaches-a-synchronous-spawn.test.ts — the census names a loop-reachable function that gains a synchronous spawn", () => {
  const fns = loopCensusFunctions();
  assert.deepEqual(refusals(fns, SYNC_SPAWN_LOOP_BASELINE), [], "a new daemon-loop path reaches a synchronous spawn");

  // Falsifier, driven on the real source: a loop-reached function with NO row gains execFileSync.
  const planted = fns.map((f) =>
    f.name === "sweepLandingSteps" ? { ...f, body: f.body + '\n  execFileSync("git", ["fetch"]);' } : f,
  );
  const named = refusals(planted, SYNC_SPAWN_LOOP_BASELINE);
  assert.equal(named.length, 1);
  assert.match(named[0]!, /^sweepLandingSteps makes 1 synchronous spawn call\(s\) and is reachable from the daemon loop/);

  // A function with a row gains one more call: named, with both numbers.
  const grown = fns.map((f) =>
    f.name === "syncPlanFromOrigin" ? { ...f, body: f.body + '\n  spawnSync("git", ["fetch"]);' } : f,
  );
  const above = refusals(grown, SYNC_SPAWN_LOOP_BASELINE);
  assert.equal(above.length, 1);
  assert.match(above[0]!, /^syncPlanFromOrigin makes 3 synchronous spawn call\(s\) on the daemon loop, above its SYNC_SPAWN_LOOP_BASELINE row of 2/);

  // The sync gh wrappers and the blocking sleeps count; their awaited forms do not.
  for (const call of ["ghExec(a)", "ghExecFile(a)", "ghJson(a)", "Atomics.wait(a, 0, 0, 1)", "defaultBlockingSleepSync(1)", "execSync(a)"]) {
    assert.equal(syncSpawnCalls({ name: "x", file: "x", body: `  ${call};` }), 1, call);
  }
  for (const call of ["ghExecAsync(a)", "ghJsonAsync(a)", "execFile(a)", "spawn(a)"]) {
    assert.equal(syncSpawnCalls({ name: "x", file: "x", body: `  ${call};` }), 0, call);
  }

  // A function the loop does NOT reach may spawn freely (CLI-only).
  const offLoop = [...fns, { name: "someCliOnlyVerb", file: "x", body: 'function someCliOnlyVerb() { execSync("x"); }' }];
  assert.deepEqual(refusals(offLoop, SYNC_SPAWN_LOOP_BASELINE), []);
});

test("unit test: test/no-daemon-loop-path-reaches-a-synchronous-spawn.test.ts — a count below its row fails and names the row to lower", () => {
  const fns = loopCensusFunctions();
  // Exact on the real source: no row holds slack today.
  assert.deepEqual(refusals(fns, SYNC_SPAWN_LOOP_BASELINE), [], "every row equals its loop-reachable count");

  // A slack row (above the real count) is refused, naming the row, its new value and the file to edit.
  const real = population(fns).get("syncPlanFromOrigin")!;
  const slack = refusals(fns, { ...SYNC_SPAWN_LOOP_BASELINE, syncPlanFromOrigin: real + 7 });
  assert.deepEqual(slack, [
    `syncPlanFromOrigin makes ${real} synchronous spawn call(s) on the daemon loop < row ${real + 7} — lower SYNC_SPAWN_LOOP_BASELINE \`syncPlanFromOrigin\` to ${real} (test/no-daemon-loop-path-reaches-a-synchronous-spawn.test.ts) in this PR`,
  ]);

  // A converter that awaits ONE of the real sites, and leaves the row alone, is told to lower it by one.
  const converted = fns.map((f) =>
    f.name === "syncPlanFromOrigin" ? { ...f, body: f.body.replace("execFileSync(", "execFileAsync(") } : f,
  );
  const lowered = refusals(converted, SYNC_SPAWN_LOOP_BASELINE);
  assert.equal(lowered.length, 1);
  assert.match(lowered[0]!, new RegExp(`^syncPlanFromOrigin makes ${real - 1} synchronous spawn call\\(s\\) on the daemon loop < row ${real} — lower SYNC_SPAWN_LOOP_BASELINE \`syncPlanFromOrigin\` to ${real - 1} `));

  // A converter that awaits EVERY site is told to delete the row, not to lower it to 0.
  const emptied = fns.map((f) =>
    f.name === "syncPlanFromOrigin" ? { ...f, body: f.body.replace(SYNC_SPAWN_CALL, "noop(").replace(SYNC_SPAWN_VALUE, " noop") } : f,
  );
  assert.deepEqual(refusals(emptied, SYNC_SPAWN_LOOP_BASELINE), [
    `syncPlanFromOrigin makes 0 synchronous spawn call(s) on the daemon loop < row ${real} — delete the \`syncPlanFromOrigin\` row from SYNC_SPAWN_LOOP_BASELINE (test/no-daemon-loop-path-reaches-a-synchronous-spawn.test.ts) in this PR`,
  ]);

  // A row whose function the loop no longer reaches counts 0 there, so its row is deleted too.
  const offLoop = [...fns, { name: "someCliOnlyVerb", file: "x", body: 'function someCliOnlyVerb() { execSync("x"); }' }];
  assert.deepEqual(refusals(offLoop, { ...SYNC_SPAWN_LOOP_BASELINE, someCliOnlyVerb: 1 }), [
    "someCliOnlyVerb makes 0 synchronous spawn call(s) on the daemon loop < row 1 — delete the `someCliOnlyVerb` row from SYNC_SPAWN_LOOP_BASELINE (test/no-daemon-loop-path-reaches-a-synchronous-spawn.test.ts) in this PR",
  ]);
});

test("unit test: test/no-daemon-loop-path-reaches-a-synchronous-spawn.test.ts — a sync primitive handed over as a seam default counts", () => {
  // A primitive handed over as a value counts where it is handed over; a type, a string or a comparison does not.
  for (const handed of ["exec = execFileSync,", "run: typeof spawnSync = spawnSync", "(deps.execFile ?? execFileSync)(a)",
    "fetchOpenPrsRest(o, r, ghJson)", "ensureDeps(cwd, execFileSync, runner)", "{ exec: execSync }", "deps.git || ghExec"]) {
    assert.equal(syncSpawnCalls({ name: "x", file: "x", body: `  ${handed};` }), 1, handed);
  }
  for (const inert of ["exec?: typeof execFileSync", "if (exec === execFileSync) return", 'const names = ["execFileSync", "spawnSync"]',
    "exec !== spawnSync", "execFileSyncFn(a)", "ghJsonAsync"]) {
    assert.equal(syncSpawnCalls({ name: "x", file: "x", body: `  ${inert};` }), 0, inert);
  }

  // The two loop stalls of 2026-10-10 that spawned through a seam default are counted and reached, never zero.
  const fns = loopCensusFunctions();
  const pop = population(fns);
  const reach = loopReachable(fns, "daemonCommand");
  assert.ok((pop.get("mergeDirectViaRest") ?? 0) > 0 && reach.has("mergeDirectViaRest"), "mergeDirectViaRest hands a sync primitive to its own call and is reached");
  // W1-T7744: checkFixCensusSnapshot keeps its spawnSync seam default, and the census still counts it, but the fix rung
  // and the census-push repair now await checkFixCensusSnapshotAsync, so the loop no longer reaches the sync form.
  assert.ok((pop.get("checkFixCensusSnapshot") ?? 0) > 0, "the sync census check's seam default is still counted");
  assert.ok(!reach.has("checkFixCensusSnapshot"), "no daemon-loop path reaches the sync census check (W1-T7744)");

  // Falsifier on the real source: a reached function with no row gains a seam that defaults to the primitive.
  const seamed = fns.map((f) =>
    f.name === "sweepLandingSteps" ? { ...f, body: f.body + "\n  const run = deps.run ?? spawnSync;" } : f,
  );
  const named = refusals(seamed, SYNC_SPAWN_LOOP_BASELINE);
  assert.equal(named.length, 1);
  assert.match(named[0]!, /^sweepLandingSteps makes 1 synchronous spawn call\(s\) and is reachable from the daemon loop/);

  // The garden idle checks that froze the loop for up to 17.9 s hold no row: a sync HEAD read there is refused.
  for (const spec of ["ciFrictionGardenSpec", "gateGardenSpec", "hotFileGardenSpec"]) {
    assert.ok(reach.has(spec) && !(spec in SYNC_SPAWN_LOOP_BASELINE), `${spec} is reached and holds no sync-spawn row`);
  }
});

test("an emptied population scan fails the positive control", () => {
  const fns = loopCensusFunctions();
  const blind = fns.map((f) => ({ ...f, body: f.body.replace(SYNC_SPAWN_CALL, "noop(").replace(SYNC_SPAWN_VALUE, " noop") }));
  assert.ok(!population(blind).has("syncPlanFromOrigin"), "a scan that matches nothing finds no population");
  assert.ok(population(fns).has("syncPlanFromOrigin"), "the real scan finds the positive control");
});

test("the baseline records only positive counts for real functions", () => {
  const names = new Set(loopCensusFunctions().map((f) => f.name));
  for (const [name, count] of Object.entries(SYNC_SPAWN_LOOP_BASELINE)) {
    assert.ok(Number.isInteger(count) && count > 0, `${name} must carry a positive count`);
    assert.ok(names.has(name), `${name} no longer exists — delete its baseline row`);
  }
});

/** The sync landing chain W1-T9615 measured: captureFeedback -> landFeedback -> syncPreflightOf -> planPrPreflightAtCommit,
 *  whose in-tree checks spawnSync in runInTree (lint-plan-precheck, task-id-existence-check, the shard census). */
const SYNC_PREFLIGHT_CHAIN = ["landFeedback", "syncPreflightOf", "planPrPreflightAtCommit", "runInTree"] as const;

test("W1-T9615: the SRE lane's daemon input reaches no synchronous plan-PR preflight", () => {
  const fns = loopCensusFunctions();
  // Positive controls: this walk sees the whole chain from the inline capture, and the census's own walk cannot see runInTree.
  const fromCapture = loopReachable(fns, "captureFeedback");
  assert.deepEqual(SYNC_PREFLIGHT_CHAIN.filter((name) => !fromCapture.has(name)), [], "captureFeedback reaches the sync preflight chain");
  assert.ok((population(fns).get("runInTree") ?? 0) > 0, "runInTree is a sync spawner");
  assert.ok(!loopReachable(topLevelFunctions(), "captureFeedback").has("runInTree"), "the function-only walk is blind to runInTree");
  assert.equal(codeOnly('git(["show", `origin/main:${rel(a)}`]); // main'), 'git(["",  rel(a) ""]); ', "only code is left");

  const pass = loopReachable(fns, "runSreLanePass");
  assert.ok(pass.has("stageFeedbackCaptureAsync") && pass.has("readLandedFeedbackEntryAsync"), "the pass reaches its staging capture and its landed read");
  // W1-T13368: both are the awaited forms; the pass names neither synchronous one.
  assert.ok(!pass.has("stageFeedbackCapture") && !pass.has("readLandedFeedbackEntry"), "the pass reaches a synchronous capture or landed read");
  for (const seed of ["runSreLanePass", "daemonSreLaneInput"]) {
    const reach = loopReachable(fns, seed);
    assert.deepEqual(SYNC_PREFLIGHT_CHAIN.filter((name) => reach.has(name)), [], `${seed} reaches the synchronous plan-PR preflight`);
  }
});

/** W1-T12790: the triage status landing the daemon's idle branch drives (runAutoTriage -> triageCommand ->
 *  triageCommandLocked), and the synchronous plan-PR preflight it ran on the loop until it awaited the async landing. */
const TRIAGE_LANDING_SEEDS = ["landTriageStatusOutcome", "landPrivateTriageStatus"] as const;
const TRIAGE_SYNC_PREFLIGHT = ["planPrPreflightAtCommit", "runInTree"] as const;
/** Names the name walk crosses from those seeds that run no synchronous landing. `planPrPreflight` is the landing
 *  option key the async landing reads (W1-T9736 makes the walk read keys as keys). `escalation` is the member read
 *  `message.extra.escalation` in recordEscalationIntakeOutcome. `setFeedbackStatus` lands only when its `land` option
 *  has no `stateRoot`: landPrivateTriageStatus passes a `stateRoot` and landTriageStatusOutcome passes no `land`. */
const TRIAGE_NO_LANDING_NAMES: ReadonlySet<string> = new Set(["planPrPreflight", "escalation", "setFeedbackStatus"]);

/** The first path, as names, from `seed` to a name in `targets` that crosses none of `around`; undefined when none. */
function pathAround(fns: Fn[], seed: string, targets: readonly string[], around: ReadonlySet<string>): string[] | undefined {
  const byName = new Map<string, Fn[]>();
  for (const f of fns) byName.set(f.name, [...(byName.get(f.name) ?? []), f]);
  const parent = new Map<string, string | undefined>([[seed, undefined]]);
  const queue = [seed];
  while (queue.length) {
    const name = queue.shift()!;
    if ((targets as readonly string[]).includes(name)) {
      const path = [name];
      for (let up = parent.get(name); up !== undefined; up = parent.get(up)) path.unshift(up);
      return path;
    }
    for (const f of byName.get(name) ?? []) {
      for (const id of f.body.match(/[A-Za-z_$][\w$]*/g) ?? []) {
        if (byName.has(id) && !parent.has(id) && !around.has(id)) {
          parent.set(id, name);
          queue.push(id);
        }
      }
    }
  }
  return undefined;
}

/** One refusal per seed whose walk reaches the synchronous plan-PR preflight, naming the seed and the path. */
function triageLandingRefusals(fns: Fn[]): string[] {
  return TRIAGE_LANDING_SEEDS.flatMap((seed) => {
    const path = pathAround(fns, seed, TRIAGE_SYNC_PREFLIGHT, TRIAGE_NO_LANDING_NAMES);
    return path === undefined ? [] : [`${seed} reaches the synchronous plan-PR preflight: ${path.join(" > ")}`];
  });
}

test("W1-T12790 criterion 4: the triage status landing reaches no synchronous plan-PR preflight, and no census row rises", () => {
  const fns = loopCensusFunctions();
  const daemon = loopReachable(fns, "daemonCommand");
  for (const seed of TRIAGE_LANDING_SEEDS) assert.ok(daemon.has(seed), `positive control: the daemon loop reaches ${seed}`);
  assert.deepEqual(triageLandingRefusals(fns), [], "a triage status landing runs the synchronous plan-PR preflight on the loop");
  // Every name the walk goes around is still on a seed's walk: a name that left it must leave this list too.
  const reached = new Set(TRIAGE_LANDING_SEEDS.flatMap((seed) => [...loopReachable(fns, seed)]));
  for (const name of TRIAGE_NO_LANDING_NAMES) assert.ok(reached.has(name), `${name} is no longer on a seed's walk; delete it`);
  // Positive control: the walk without those names does reach the preflight, so the check above cannot pass vacuously.
  assert.ok(pathAround(fns, "landTriageStatusOutcome", TRIAGE_SYNC_PREFLIGHT, new Set()), "the plain walk reaches the preflight by name");
  // Positive control: putting the synchronous landing call back fails with the seed's name.
  for (const seed of TRIAGE_LANDING_SEEDS) {
    const reverted = fns.map((f) => (f.name === seed ? { ...f, body: `${f.body}\nlandFeedbackStatusContent(root, relPath, content, opts);` } : f));
    const found = triageLandingRefusals(reverted);
    const named = `${seed} reaches the synchronous plan-PR preflight: ${seed} > landFeedbackStatusContent > `;
    assert.ok(found.some((m) => m.startsWith(named)), `the reverted ${seed} is refused by name: ${found.join(" | ")}`);
  }
  assert.deepEqual(refusals(fns, SYNC_SPAWN_LOOP_BASELINE), [], "no SYNC_SPAWN_LOOP_BASELINE row rises and no name is added");
});

/** W1-T9696: daemon-loop captures that now stage for the async sweep, and so never name captureFeedback. */
const STAGED_CAPTURE_SEEDS = ["pollIssues", "pollAlerts", "productionIssueRevalidationPorts", "feedbackEvidenceCoverageFiler"] as const;

test("W1-T9696: the staged daemon-loop captures reach no inline captureFeedback", () => {
  const fns = loopCensusFunctions();
  // Positive control: the CLI verbs inject the inline capture, and this walk sees it.
  assert.ok(loopReachable(fns, "issuesCommand").has("captureFeedback") && loopReachable(fns, "opsCommand").has("captureFeedback"));
  for (const seed of STAGED_CAPTURE_SEEDS) {
    const reach = loopReachable(fns, seed);
    assert.ok(reach.has("stageFeedbackCapture"), `${seed} reaches its staging capture`);
    assert.ok(!reach.has("captureFeedback"), `${seed} reaches the inline captureFeedback`);
  }
});

/** Reached only through a column-0 object-literal const, so the function-only walk never saw them (W1-T9660). */
const OBJECT_LITERAL_SPAWNERS = ["runInTree"] as const;

test("W1-T9660: the daemon-wide census reaches a sync spawner named only inside an object-literal const", () => {
  const fns = loopCensusFunctions();
  const reach = loopReachable(fns, "daemonCommand");
  const pop = population(fns);
  assert.ok(reach.has("defaultPreflightChecks"), "the census walk reads plan-pr-emitter's defaultPreflightChecks object literal");
  for (const name of OBJECT_LITERAL_SPAWNERS) {
    assert.ok(reach.has(name) && (pop.get(name) ?? 0) > 0, `${name} is a reached sync spawner`);
    assert.equal(SYNC_SPAWN_LOOP_BASELINE[name], pop.get(name), `${name} holds an exact row`);
  }
  // Every path to runInTree passes through an object literal: the function-only walk, strings stripped alike, is blind to it.
  const functionsOnly = topLevelFunctions().map((f) => ({ ...f, body: codeOnly(f.body) }));
  assert.ok(!loopReachable(functionsOnly, "daemonCommand").has("runInTree"), "the function-only walk does not reach runInTree");
  assert.ok(loopReachable(functionsOnly, "daemonCommand").size < reach.size, "the object-literal walk reaches more");
  const { runInTree: _dropped, ...withoutRow } = SYNC_SPAWN_LOOP_BASELINE;
  assert.deepEqual(refusals(fns, withoutRow), [
    "runInTree makes 1 synchronous spawn call(s) and is reachable from the daemon loop (daemonCommand), but is not in SYNC_SPAWN_LOOP_BASELINE — await an async seam instead",
  ]);
});

/** Rows the loop "reached" only through a word in a string or a comment (drainCommand is named in daemonCommand's comments). */
const TEXT_ONLY_ROWS = ["imessageChannel", "listRuleSuites", "readPushedRunBranchesOutput", "readRunBranchClosedPrsOutput"] as const;

test("W1-T9660: the daemon-wide census ignores an identifier that appears only in a string or a comment", () => {
  const fns = loopCensusFunctions();
  const reach = loopReachable(fns, "daemonCommand");
  // Positive control: the same walk with text kept reaches drainCommand from daemonCommand; the census walk does not.
  assert.ok(loopReachable(topLevelFunctions({ objectLiterals: true }), "daemonCommand").has("drainCommand"), "text-keeping walk reaches drainCommand");
  assert.ok(!reach.has("drainCommand"), "daemonCommand names drainCommand only in comments");
  for (const name of TEXT_ONLY_ROWS) {
    assert.ok(!reach.has(name) && !Object.hasOwn(SYNC_SPAWN_LOOP_BASELINE, name), `${name} is unreached and holds no row`);
    assert.deepEqual(refusals(fns, { ...SYNC_SPAWN_LOOP_BASELINE, [name]: 1 }), [
      `${name} makes 0 synchronous spawn call(s) on the daemon loop < row 1 — delete the \`${name}\` row from SYNC_SPAWN_LOOP_BASELINE (${BASELINE_FILE}) in this PR`,
    ]);
  }
  // A backtick inside a regex literal opens no template: the code after it, and its spawn, stay visible.
  assert.equal(codeOnly("x(/[;&|`$]/.test(p)); a / b / c; /* `t */ (e ?? execFileSync)(z);"), 'x("".test(p)); a / b / c;   (e ?? execFileSync)(z);');
  assert.ok(reach.has("assertOpenWeightToolBoundary") && (population(fns).get("assertOpenWeightToolBoundary") ?? 0) > 0, "runTask's cash-containment default stays a counted, reached spawner");
});

/** W1-T9701: evaluated once while run-task.ts and benchmark-run.ts load, before daemonCommand runs. */
const MODULE_LOAD_CAPTURES = ["captureImportedModule", "executingHarnessRevision"] as const;

test("W1-T9701: the census attributes a const initializer call to module load, not the loop", () => {
  const fns = loopCensusFunctions();
  const reach = loopReachable(fns, "daemonCommand");
  const pop = population(fns);
  const atLoad = loopReachable(fns, MODULE_LOAD);
  assert.ok(reach.has("runTask") && reach.has("workerBoundaryStack"), "positive control: the loop still reaches runTask and the const it names");
  for (const name of MODULE_LOAD_CAPTURES) {
    assert.ok((pop.get(name) ?? 0) > 0, `${name} is still a counted sync spawner`);
    assert.ok(!reach.has(name), `${name} runs at module load, not on the daemon loop`);
    assert.ok(atLoad.has(name), `the module-load node holds ${name}`);
    assert.ok(!Object.hasOwn(SYNC_SPAWN_LOOP_BASELINE, name), `${name} holds no row`);
  }
  // The node is not identifier-shaped, so no body names it and no daemon path reaches it.
  assert.ok(!reach.has(MODULE_LOAD));
  // Falsifier: walked without the split, the loop reaches both again through runTask > workerBoundaryStack.
  const unsplit = fns.map((f) => (f.name === "workerBoundaryStack" ? { ...f, body: `${f.body}\n${fns.filter((g) => g.name === MODULE_LOAD && g.file === f.file).map((g) => g.body).join("\n")}` } : f));
  assert.ok(loopReachable(unsplit, "daemonCommand").has("captureImportedModule"));
});

test("W1-T9701: an object literal member function is still loop reach", () => {
  const fns = loopCensusFunctions();
  // Arrow members: plan-pr-emitter's defaultPreflightChecks still reaches the in-tree spawn its arrows call.
  assert.ok(loopReachable(fns, "defaultPreflightChecks").has("runInTree"), "an arrow member's callee is reached");
  // Handed-over values: REAL_ALERT_FIX_DISPATCH_DEPS still reaches the seams it hands the dispatch.
  const deps = loopReachable(fns, "REAL_ALERT_FIX_DISPATCH_DEPS");
  assert.ok(deps.has("worktreeAddAsync") && deps.has("ensureTaskTrailer"), "a handed-over member is reached");

  // Synthetic: a literal with a call-valued member, an arrow member, a handed-over member, a call passed a function,
  // a method, and a column-0 statement after it. Only what the initializer evaluates goes to module load.
  const source = [
    "const fixture = {",
    "  pinned: atLoad(fileURLToPath(import.meta.url)),",
    "  run: (a) => onLoop(a),",
    "  handed: handedOver,",
    "  wrapped: memoize(() => wrappedOnLoop()),",
    "  method(x) { return inMethod(x); },",
    "};",
    "fixture.later = afterLiteral(fixture.pinned);",
  ].join("\n");
  const { reach, load } = splitObjectLiteral(source, source.indexOf("{"));
  assert.equal(reach.length, source.length, "both halves keep the body's length");
  const synthetic: Fn[] = [
    { name: "seed", file: "x", body: "function seed() { fixture; }" },
    { name: "fixture", file: "x", body: reach },
    { name: MODULE_LOAD, file: "x", body: load },
    ...["atLoad", "onLoop", "handedOver", "memoize", "wrappedOnLoop", "inMethod", "afterLiteral"].map((name) => ({ name, file: "x", body: `function ${name}() {}` })),
  ];
  const fromSeed = loopReachable(synthetic, "seed");
  assert.deepEqual(["onLoop", "handedOver", "memoize", "wrappedOnLoop", "inMethod"].filter((n) => !fromSeed.has(n)), [], "functions and handed-over values stay reached");
  assert.deepEqual(["atLoad", "afterLiteral"].filter((n) => fromSeed.has(n)), [], "initializer calls are not reached from the seed");
  assert.deepEqual(["atLoad", "afterLiteral"].filter((n) => !loopReachable(synthetic, MODULE_LOAD).has(n)), [], "the module-load node holds them");
});

test("W1-T9737: a factory member of a const initializer stays loop reach", () => {
  const fns = loopCensusFunctions();
  const factories = factoryNames(fns);
  // The real seam: a factory whose declared return type is `typeof spawnWorker`, handed to the alert-fix dispatch.
  assert.ok(factories.has("ledgeredNonDispatchSpawn"), "a `typeof <function>` return type makes a factory");
  const real = fns.find((f) => f.name === "REAL_ALERT_FIX_DISPATCH_DEPS");
  assert.ok(real && /spawn:\s*ledgeredNonDispatchSpawn\(/.test(real.body), "REAL_ALERT_FIX_DISPATCH_DEPS.spawn is reach, not module load");
  assert.ok(loopReachable(fns, "REAL_ALERT_FIX_DISPATCH_DEPS").has("ledgeredNonDispatchSpawn"));
  // The data-returning captures still move to module load (W1-T9701).
  for (const name of MODULE_LOAD_CAPTURES) assert.ok(!factories.has(name), `${name} returns data`);

  // Synthetic: each of the three forms makes a factory; a closure's sync spawn is reached from a function naming the literal.
  const source = ["const D = {", '  spawn: makeSpawner("x"),', "};"].join("\n");
  const sources: Record<string, string> = {
    makeSpawner: 'function makeSpawner(lane) {\n  return (cmd) => spawnSync(cmd, [lane]);\n}',
    viaIdentifier: "function viaIdentifier(lane) {\n  const run = (cmd) => spawnSync(cmd, [lane]);\n  return run;\n}",
    viaType: "function viaType(lane): typeof spawnSync {\n  return pick(lane);\n}",
    viaFunctionType: "function viaFunctionType(lane): (cmd: string) => number {\n  return pick(lane);\n}",
  };
  const defs: Fn[] = Object.entries(sources).map(([name, body]) => ({ name, file: "x", body }));
  defs.push({ name: "spawnSync", file: "x", body: "function spawnSync() {}" });
  const set = factoryNames(defs);
  for (const name of Object.keys(sources)) assert.ok(set.has(name), `${name} is a factory`);
  const split = splitObjectLiteral(source, source.indexOf("{"), set);
  const synthetic: Fn[] = [
    { name: "seed", file: "x", body: "function seed() { D; }" },
    { name: "D", file: "x", body: split.reach },
    { name: MODULE_LOAD, file: "x", body: split.load },
    ...defs,
  ];
  assert.ok(loopReachable(synthetic, "seed").has("spawnSync"), "a sync spawn inside the factory's returned closure is loop reach");
  // Falsifier: without the factory index the member moves to module load and the spawn escapes the loop walk.
  const blind = splitObjectLiteral(source, source.indexOf("{"));
  const unaware = synthetic.map((f) => (f.name === "D" ? { ...f, body: blind.reach } : f.name === MODULE_LOAD ? { ...f, body: blind.load } : f));
  assert.ok(!loopReachable(unaware, "seed").has("spawnSync"));
});

test("W1-T9737: a data-returning initializer call stays module load", () => {
  const source = ["const D = {", '  id: captureId("x"),', '  made: new Thing("y"),', "};"].join("\n");
  const defs: Fn[] = [
    { name: "captureId", file: "x", body: "function captureId(x) {\n  return `${x}-id`;\n}" },
    { name: "Thing", file: "x", body: "function Thing(y) {\n  return pick(y);\n}" },
    { name: "pick", file: "x", body: "function pick(y) { return y; }" },
  ];
  const factories = factoryNames(defs);
  assert.ok(!factories.has("captureId") && !factories.has("pick"), "a callee returning data is no factory");
  const { reach, load } = splitObjectLiteral(source, source.indexOf("{"), factories);
  const synthetic: Fn[] = [{ name: "seed", file: "x", body: "function seed() { D; }" }, { name: "D", file: "x", body: reach }, { name: MODULE_LOAD, file: "x", body: load }, ...defs];
  const fromSeed = loopReachable(synthetic, "seed");
  assert.ok(!fromSeed.has("captureId") && !fromSeed.has("Thing"), "data-returning calls are not loop reach");
  assert.ok(loopReachable(synthetic, MODULE_LOAD).has("captureId"), "the module-load node holds the call");
});

test("W1-T12791 criterion 4: repairPrMetadata's merge-plan read awaits the async git leaf and no row rises", () => {
  const fns = loopCensusFunctions();
  const reach = loopReachable(fns, "daemonCommand");
  assert.ok(reach.has("repairPrMetadata"), "the daemon loop reaches repairPrMetadata");
  for (const name of MERGE_PLAN_READERS) assert.ok(reach.has(name), `the daemon loop reaches ${name} through repairPrMetadata`);
  assert.ok(SYNC_SPAWN_LOOP_BASELINE.repairPrMetadata! <= 2, "the repairPrMetadata row does not rise");
  assert.ok((population(fns).get("repairPrMetadata") ?? 0) <= 2, "repairPrMetadata itself makes no new synchronous call");
  assert.deepEqual(mergePlanReadRefusals(fns), [], "the merge-plan read is awaited");
  assert.deepEqual(refusals(fns, SYNC_SPAWN_LOOP_BASELINE).filter((r) => /repairPrMetadata|ForRepair|repairCheckoutTopLevel/.test(r)), []);

  // Falsifier on the real source: the merge read moved to the synchronous leaf is named under repairPrMetadata.
  const synchronous = fns.map((f) =>
    f.name === "mergeCommitForRepair" ? { ...f, body: f.body.replace(/await hostWorktreeGitAsync\(/g, "hostWorktreeGit(") } : f,
  );
  const named = mergePlanReadRefusals(synchronous);
  assert.equal(named.length, 1);
  assert.match(named[0]!, /^repairPrMetadata's plan reader mergeCommitForRepair makes 4 synchronous git call\(s\)/);
});

test("W1-T12753 criterion 5: the census counts synchronous ledger scans and names a loop function that gains one", () => {
  const fns = loopCensusFunctions();
  assert.deepEqual(refusals(fns, SYNC_LEDGER_SCAN_LOOP_BASELINE, LEDGER_SCAN_CENSUS), [], "a new daemon-loop path scans the ledger synchronously");
  const reach = loopReachable(fns, "daemonCommand");
  const pop = population(fns, syncScanCalls);
  // Positive control: a reachable sync scanner, so the walk cannot pass vacuously.
  assert.ok(reach.has("readMergeCreditedTaskIds") && (pop.get("readMergeCreditedTaskIds") ?? 0) > 0, "readMergeCreditedTaskIds is a reachable sync scanner");
  // The lifetime-pressure route and the sync verdict reader hold no row: the route reads through the async readers.
  for (const name of ["routeAdaptiveLifetimePressure", "rowsWithArchivedVerifyHumanVerdicts"]) {
    assert.ok(!Object.hasOwn(SYNC_LEDGER_SCAN_LOOP_BASELINE, name), `${name} holds no sync-ledger-scan row`);
  }
  assert.ok(reach.has("routeAdaptiveLifetimePressure") && !pop.has("routeAdaptiveLifetimePressure"), "the route is reached and scans nothing synchronously");
  assert.ok(!reach.has("rowsWithArchivedVerifyHumanVerdicts"), "no daemon-loop path reaches the sync verdict reader");

  // Each primitive counts once; the async readers and a definition do not.
  for (const call of ["readLedgerUnionRecordsSync(d)", "ledgerRowsForSync(d, q)", "readLedgerLines(p)"]) {
    assert.equal(syncScanCalls({ name: "x", file: "x", body: `  ${call};` }), 1, call);
  }
  for (const call of ["ledgerRowsFor(d, q)", "readLedgerUnionRecords(d)", "readLedgerLinesAsync(p)"]) {
    assert.equal(syncScanCalls({ name: "x", file: "x", body: `  ${call};` }), 0, call);
  }
  assert.equal(syncScanCalls({ name: "readLedgerLines", file: "x", body: "export function readLedgerLines(path) {}" }), 0);

  // Falsifier, driven on the real source: the route gains a sync live read and is named.
  const planted = fns.map((f) => (f.name === "routeAdaptiveLifetimePressure" ? { ...f, body: `${f.body}\n  readLedgerLines(deps.ledgerPath);` } : f));
  const named = refusals(planted, SYNC_LEDGER_SCAN_LOOP_BASELINE, LEDGER_SCAN_CENSUS);
  assert.equal(named.length, 1);
  assert.match(named[0]!, /^routeAdaptiveLifetimePressure makes 1 synchronous ledger scan\(s\) and is reachable from the daemon loop \(daemonCommand\), but is not in SYNC_LEDGER_SCAN_LOOP_BASELINE/);
  // A row that holds slack is refused too, so no row can rise unseen later.
  const real = pop.get("readMergeCreditedTaskIds")!;
  assert.deepEqual(refusals(fns, { ...SYNC_LEDGER_SCAN_LOOP_BASELINE, readMergeCreditedTaskIds: real + 1 }, LEDGER_SCAN_CENSUS), [
    `readMergeCreditedTaskIds makes ${real} synchronous ledger scan(s) on the daemon loop < row ${real + 1} — lower SYNC_LEDGER_SCAN_LOOP_BASELINE \`readMergeCreditedTaskIds\` to ${real} (${BASELINE_FILE}) in this PR`,
  ]);
  for (const [name, count] of Object.entries(SYNC_LEDGER_SCAN_LOOP_BASELINE)) {
    assert.ok(Number.isInteger(count) && count > 0, `${name} must carry a positive count`);
  }
});

test("W1-T13416: the ledger census counts the raw-lines union reader", () => {
  const count = (body: string) => syncScanCalls({ name: "fixture", file: "fixture.ts", body: codeOnly(body) });
  const reader = "readLedgerUnionRawLinesSync";
  assert.equal(count(`${reader}(stateDir)`), 1);
  assert.equal(count(`export function ${reader}(stateDir) {}`), 0);
  assert.equal(count("await readLedgerUnionRawLinesAsync(stateDir)"), 0);
  assert.equal(count('log("readLedgerUnionRawLinesSync(stateDir)"); // readLedgerUnionRawLinesSync(stateDir)'), 0);

  const pop = population(loopCensusFunctions(), syncScanCalls);
  assert.equal(pop.get("resolveLedgerUnion"), 1);
});

test("W1-T13416: the ledger census counts synchronous zlib", () => {
  const count = (body: string) => syncScanCalls({ name: "fixture", file: "fixture.ts", body: codeOnly(body) });
  for (const call of [
    "fsDeps.gunzipSync(buffer)",
    "nodeGunzipSync(buffer)",
    "zlib.inflateRawSync(buffer)",
    "zlib.gzipSync(buffer)",
  ]) {
    assert.equal(count(call), 1, call);
  }
  for (const source of [
    "zlib.gunzip(buffer, done)",
    "createGunzip()",
    'log("gunzipSync(buffer)"); // gunzipSync(buffer)',
  ]) {
    assert.equal(count(source), 0, source);
  }

  const pop = population(loopCensusFunctions(), syncScanCalls);
  assert.equal(pop.get("readLedgerUnionRawLinesSync"), 1);
});

test("W1-T13416: the ledger census counts a reader handed over as a value", () => {
  const count = (body: string) => syncScanCalls({ name: "fixture", file: "fixture.ts", body: codeOnly(body) });
  for (const source of [
    "function read(reader = readLedgerUnionRecordsSync) {}",
    "const read = deps.read ?? ledgerRowsForSync;",
    "buildReader(readLedgerLines);",
    "const deps = { read: readLedgerUnionRawLinesSync };",
    "const deps = { readLedgerUnionRawLinesSync };",
    "const unzip = fsDeps.gunzipSync;",
    "return readLedgerUnionRawLinesSync;",
    "(deps.read ?? readLedgerUnionRawLinesSync)(stateDir);",
  ]) {
    assert.equal(count(source), 1, source);
  }
  for (const source of [
    "type Read = typeof readLedgerUnionRawLinesSync;",
    "const same = deps.read === readLedgerUnionRawLinesSync;",
    "const same = readLedgerUnionRawLinesSync === deps.read;",
    "if (unavailable || readLedgerUnionRawLinesSync === undefined) return;",
    "const deps = { readLedgerUnionRawLinesSync: asyncRead };",
    'const name = "ledgerRowsForSync";',
    "buildReader(readLedgerUnionRawLinesSyncForTest);",
  ]) {
    assert.equal(count(source), 0, source);
  }

  const pop = population(loopCensusFunctions(), syncScanCalls);
  assert.equal(pop.get("readConfigGardenLedgerRows"), 1);
});

test("W1-T13416: the ledger census names a new loop-reachable caller of a whole-corpus reader", () => {
  const fns = loopCensusFunctions();
  const caller = {
    name: "readWholeLedgerForTick",
    file: "fixture.ts",
    body: "return readLedgerUnionRawLinesSync(stateDir);",
  };
  const offLoop = [...fns, caller];
  assert.ok(!loopReachable(offLoop, "daemonCommand").has(caller.name));
  assert.deepEqual(refusals(offLoop, SYNC_LEDGER_SCAN_LOOP_BASELINE, LEDGER_SCAN_CENSUS), []);

  const onLoop = offLoop.map((fn) => fn.name === "routeAdaptiveLifetimePressure"
    ? { ...fn, body: `${fn.body}\n  readWholeLedgerForTick(stateDir);` }
    : fn);
  assert.ok(loopReachable(onLoop, "daemonCommand").has(caller.name));
  const named = refusals(onLoop, SYNC_LEDGER_SCAN_LOOP_BASELINE, LEDGER_SCAN_CENSUS);
  assert.deepEqual(named, [
    "readWholeLedgerForTick makes 1 synchronous ledger scan(s) and is reachable from the daemon loop (daemonCommand), but is not in SYNC_LEDGER_SCAN_LOOP_BASELINE — await an async ledger reader instead",
  ]);
});

test("W1-T12753 criterion 4: the daemon's verify-human cadence reads its ledger rows through the async readers", () => {
  const fns = loopCensusFunctions();
  const reach = loopReachable(fns, "daemonCommand");
  assert.ok(reach.has("defaultVerifyHumanCadenceResult"), "the loop reaches the verify-human cadence");
  assert.ok(!Object.hasOwn(SYNC_LEDGER_SCAN_LOOP_BASELINE, "defaultVerifyHumanCadenceResult"), "the cadence holds no sync-ledger-scan row");
  assert.equal(population(fns, syncScanCalls).get("defaultVerifyHumanCadenceResult") ?? 0, 0);
  for (const name of ["rowsWithArchivedVerifyHumanVerdictsAsync", "parkedVerifyHumanShardsAsync"]) {
    assert.ok(reach.has(name), `the loop reaches ${name}`);
  }
  // The sync src/ citation grep is no longer on the loop, so its sync-spawn row is gone (criterion 3's census half).
  assert.ok(!Object.hasOwn(SYNC_SPAWN_LOOP_BASELINE, "idCitedInSrc") && !reach.has("idCitedInSrcSync"), "no daemon-loop path reaches the sync citation grep");
  // Falsifier: the cadence's sync live read put back is named.
  const planted = fns.map((f) => (f.name === "defaultVerifyHumanCadenceResult" ? { ...f, body: `${f.body}\n  readLedgerLines(ledgerPath);` } : f));
  assert.deepEqual(refusals(planted, SYNC_LEDGER_SCAN_LOOP_BASELINE, LEDGER_SCAN_CENSUS), [
    "defaultVerifyHumanCadenceResult makes 1 synchronous ledger scan(s) and is reachable from the daemon loop (daemonCommand), but is not in SYNC_LEDGER_SCAN_LOOP_BASELINE — await an async ledger reader instead",
  ]);
});

test("W1-T12954 criterion 6: the sweep's repair-history read lowers its sync-ledger-scan row and no row rises", () => {
  const fns = loopCensusFunctions();
  const reach = loopReachable(fns, "daemonCommand");
  const pop = population(fns, syncScanCalls);
  assert.ok(reach.has("runSweep") && reach.has("readSweepRepairHistory") && reach.has("readOpenEscalationHistory"),
    "the loop reaches the sweep, its repair-history reader and its open-escalation history reader");
  // W1-T13969: the open-escalation read awaits readOpenEscalationHistory, the last synchronous scan in runSweep, so its row is gone.
  assert.equal(Object.hasOwn(SYNC_LEDGER_SCAN_LOOP_BASELINE, "runSweep"), false, "the sweep has no sync-ledger-scan row");
  assert.equal(pop.get("runSweep") ?? 0, 0, "runSweep makes no synchronous ledger-union scan");
  assert.equal(pop.get("readOpenEscalationHistory") ?? 0, 0, "the open-escalation history reader scans nothing synchronously");
  assert.equal(pop.get("readSweepRepairHistory") ?? 0, 0, "the repair-history reader scans nothing synchronously");
  assert.deepEqual(refusals(fns, SYNC_LEDGER_SCAN_LOOP_BASELINE, LEDGER_SCAN_CENSUS), [], "no row rises");
  // Falsifier: the sync union read put back in the reader is named.
  const planted = fns.map((f) => (f.name === "readSweepRepairHistory" ? { ...f, body: `${f.body}\n  readLedgerUnionRecordsSync(stateDir);` } : f));
  const named = refusals(planted, SYNC_LEDGER_SCAN_LOOP_BASELINE, LEDGER_SCAN_CENSUS);
  assert.equal(named.length, 1);
  assert.match(named[0]!, /^readSweepRepairHistory makes 1 synchronous ledger scan\(s\) and is reachable from the daemon loop/);
  // Falsifier: a new synchronous union read in runSweep is named, now that the sweep has no row to absorb it.
  const inSweep = fns.map((f) => (f.name === "runSweep" ? { ...f, body: `${f.body}\n  readLedgerUnionRecordsSync(stateDir);` } : f));
  const sweepNamed = refusals(inSweep, SYNC_LEDGER_SCAN_LOOP_BASELINE, LEDGER_SCAN_CENSUS);
  assert.equal(sweepNamed.length, 1);
  assert.match(sweepNamed[0]!, /^runSweep makes 1 synchronous ledger scan\(s\) and is reachable from the daemon loop/);
});
