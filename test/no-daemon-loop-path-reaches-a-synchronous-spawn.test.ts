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

import { loopReachable, MODULE_LOAD, splitObjectLiteral, topLevelFunctions, type Fn } from "./helpers/daemon-loop-walk.js";

/** Loop-reachable functions that still call a synchronous spawn primitive or hand one over as a value,
 *  with the count recorded at build time (2026-10-10, f49ee17d3; re-recorded the same day on e91d490f1
 *  when the handed-over form began to count). A new name, or a count above its row, fails the census;
 *  so does a count BELOW its row: converting a site lowers its row here (or deletes it at 0) in the same PR. */
const SYNC_SPAWN_LOOP_BASELINE: Readonly<Record<string, number>> = {
  applyGhReadCadence: 1,
  assertOpenWeightToolBoundary: 1,
  assertWorkerEgressEnforcerVersion: 1,
  assessedReviewerFreshness: 1,
  authorBaseRef: 1,
  baseBranchRequiresMergeQueue: 1,
  blobShaAtRef: 1,
  blockingSleep: 1,
  buildBatchedGithub: 1,
  buildBehindMainByPr: 1,
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
  classifyHeadShaAvailability: 1,
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
  execGhStatusPost: 1,
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
  idCitedInSrc: 1,
  installPinnedChromium: 1,
  isPrMergedNow: 1,
  ladderGardenSpec: 1,
  listRegisteredWorktrees: 1,
  loadPlanAtRef: 1,
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
  planTreeIsBehindMain: 1,
  postReviewPending: 1,
  prepareDefuseTaskIds: 1,
  preserveFixHead: 3,
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
  refCommitMatchesDirtyRecovery: 3,
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
  resolvePlanCriteriaAtHead: 1,
  resolveReviewSubjectCheckout: 1,
  retroShippedGithubGateway: 1,
  reuseDonor: 1,
  reviewCommand: 1,
  reviewerCodeRecoveryFromLoadedModule: 1,
  reviewerGit: 1,
  run: 1,
  runCoverageImprovementCadence: 1,
  runGhPrCreate: 1,
  runInTree: 1, // W1-T9660: via defaultPreflightChecks; W1-T9695/W1-T9696 moved the boot sweep, daemon landContent, CI-learning and the intake/alert/revalidation/evidence/handoff captures off it. Still sync: captureFeedback from coverage-improvement, hand-run census, source-size follow-up, grilled reply, dep-review, the CLI sweep's repair capture; recordDecision, setFeedbackStatus, landFoldDebt, gardenCheckout; by name only, the planPrPreflight option and the sweepFeedbackLanding dep
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
  triageCommandLocked: 3,
  updateBranchViaGh: 1,
  vetPinnedConfig: 1,
  worktreeAdd: 5,
  worktreePushExec: 1,
  writePrBodyRest: 1,
};

let censusWalk: Fn[] | undefined;
/** W1-T9660: the ONE walk every census test reads — object-literal consts walked, strings and comments blanked
 *  ({@link codeOnly}) — so the daemon-wide census and W1-T9615's SRE-lane test cannot disagree about reach. */
function censusFunctions(): Fn[] {
  censusWalk ??= topLevelFunctions({ objectLiterals: true }).map((f) => ({ ...f, body: codeOnly(f.body) }));
  return censusWalk.slice();
}

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
function population(fns: Fn[]): Map<string, number> {
  const pop = new Map<string, number>();
  for (const f of fns) {
    const n = syncSpawnCalls(f);
    if (n > 0) pop.set(f.name, (pop.get(f.name) ?? 0) + n);
  }
  return pop;
}

/** The file holding SYNC_SPAWN_LOOP_BASELINE, named in every shrink refusal so a converter knows where to edit. */
const BASELINE_FILE = "test/no-daemon-loop-path-reaches-a-synchronous-spawn.test.ts";

/** Every loop-reachable name whose count differs from its row, with both numbers. EXACT, like the
 *  hardened-leaf census (test/every-host-git-spawn-into-a-worktree-uses-the-hardened-leaf): growth is
 *  refused, and so is shrinkage until the row is lowered (or deleted at 0) in the same PR, so the table
 *  never holds slack a later regression could refill unseen. A row whose name the loop no longer reaches
 *  counts 0. */
function refusals(fns: Fn[], baseline: Readonly<Record<string, number>>): string[] {
  const reach = loopReachable(fns, "daemonCommand");
  const pop = population(fns);
  const names = new Set([...pop.keys()].filter((n) => reach.has(n)));
  for (const n of Object.keys(baseline)) names.add(n);
  const out: string[] = [];
  for (const name of [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const count = reach.has(name) ? pop.get(name) ?? 0 : 0;
    const row = Object.hasOwn(baseline, name) ? baseline[name]! : undefined;
    if (row === undefined) {
      out.push(`${name} makes ${count} synchronous spawn call(s) and is reachable from the daemon loop (daemonCommand), but is not in SYNC_SPAWN_LOOP_BASELINE — await an async seam instead`);
    } else if (count > row) {
      out.push(`${name} makes ${count} synchronous spawn call(s) on the daemon loop, above its SYNC_SPAWN_LOOP_BASELINE row of ${row} — await an async seam instead`);
    } else if (count < row) {
      out.push(count === 0
        ? `${name} makes 0 synchronous spawn call(s) on the daemon loop < row ${row} — delete the \`${name}\` row from SYNC_SPAWN_LOOP_BASELINE (${BASELINE_FILE}) in this PR`
        : `${name} makes ${count} synchronous spawn call(s) on the daemon loop < row ${row} — lower SYNC_SPAWN_LOOP_BASELINE \`${name}\` to ${count} (${BASELINE_FILE}) in this PR`);
    }
  }
  return out;
}

test("census: the seed and the population are real, so the walk cannot pass vacuously", () => {
  const fns = censusFunctions();
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
  const fns = censusFunctions();
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
  const fns = censusFunctions();
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
  const fns = censusFunctions();
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
  const fns = censusFunctions();
  const blind = fns.map((f) => ({ ...f, body: f.body.replace(SYNC_SPAWN_CALL, "noop(").replace(SYNC_SPAWN_VALUE, " noop") }));
  assert.ok(!population(blind).has("syncPlanFromOrigin"), "a scan that matches nothing finds no population");
  assert.ok(population(fns).has("syncPlanFromOrigin"), "the real scan finds the positive control");
});

test("the baseline records only positive counts for real functions", () => {
  const names = new Set(censusFunctions().map((f) => f.name));
  for (const [name, count] of Object.entries(SYNC_SPAWN_LOOP_BASELINE)) {
    assert.ok(Number.isInteger(count) && count > 0, `${name} must carry a positive count`);
    assert.ok(names.has(name), `${name} no longer exists — delete its baseline row`);
  }
});

/** W1-T9615: `body` with string and template-literal text and trailing `//` comments blanked (a template's `${}`
 *  expressions are kept). The name walk reads every identifier-shaped word, so "origin/main" in a git argument or a
 *  comment reaches the CLI's `main`, and through it every function in src. A seeded reach only separates once they go. */
function codeOnly(body: string): string {
  let out = "";
  const braces: number[] = [];
  let inTemplate = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (inTemplate) {
      if (c === "\\") i++;
      else if (c === "`") { inTemplate = false; out += '""'; }
      else if (c === "$" && body[i + 1] === "{") { inTemplate = false; braces.push(0); out += " "; i++; }
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < body.length && body[j] !== c && body[j] !== "\n") j += body[j] === "\\" ? 2 : 1;
      out += '""';
      i = j;
    } else if (c === "`") inTemplate = true;
    else if (c === "/" && body[i + 1] === "/") {
      while (i + 1 < body.length && body[i + 1] !== "\n") i++;
    } else if (c === "/" && body[i + 1] === "*") {
      const close = body.indexOf("*/", i + 2);
      i = close < 0 ? body.length : close + 1;
      out += " ";
    } else if (c === "/" && regexLiteralEnd(body, i, out) > i) {
      i = regexLiteralEnd(body, i, out);
      while (/[a-z]/.test(body[i + 1] ?? "")) i++;
      out += '""';
    } else if (braces.length > 0 && c === "}" && braces[braces.length - 1] === 0) {
      braces.pop();
      inTemplate = true;
      out += " ";
    } else {
      if (braces.length > 0 && c === "{") braces[braces.length - 1]!++;
      if (braces.length > 0 && c === "}") braces[braces.length - 1]!--;
      out += c;
    }
  }
  return out;
}

/** W1-T9660: where the regex literal opening at `body[i]` closes, or -1 for a division. Read as a string, the backtick in
 *  worker-provider's `/[;&|`$><]/` opened a template that blanked assertOpenWeightToolBoundary's real `execFileSync`. */
function regexLiteralEnd(body: string, i: number, before: string): number {
  let k = before.length;
  while (k > 0 && /\s/.test(before[k - 1]!)) k--;
  const prev = before.slice(Math.max(0, k - 8), k);
  if (prev !== "" && !/[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) && !/(?:^|[^\w$])(?:return|typeof|case|void|in|of|throw|yield|await)$/.test(prev)) return -1;
  let inClass = false;
  for (let j = i + 1; j < body.length && body[j] !== "\n"; j++) {
    if (body[j] === "\\") j++;
    else if (body[j] === "[") inClass = true;
    else if (body[j] === "]") inClass = false;
    else if (body[j] === "/" && !inClass) return j;
  }
  return -1;
}

/** The sync landing chain W1-T9615 measured: captureFeedback -> landFeedback -> syncPreflightOf -> planPrPreflightAtCommit,
 *  whose in-tree checks spawnSync in runInTree (lint-plan-precheck, task-id-existence-check, the shard census). */
const SYNC_PREFLIGHT_CHAIN = ["landFeedback", "syncPreflightOf", "planPrPreflightAtCommit", "runInTree"] as const;

test("W1-T9615: the SRE lane's daemon input reaches no synchronous plan-PR preflight", () => {
  const fns = censusFunctions();
  // Positive controls: this walk sees the whole chain from the inline capture, and the census's own walk cannot see runInTree.
  const fromCapture = loopReachable(fns, "captureFeedback");
  assert.deepEqual(SYNC_PREFLIGHT_CHAIN.filter((name) => !fromCapture.has(name)), [], "captureFeedback reaches the sync preflight chain");
  assert.ok((population(fns).get("runInTree") ?? 0) > 0, "runInTree is a sync spawner");
  assert.ok(!loopReachable(topLevelFunctions(), "captureFeedback").has("runInTree"), "the function-only walk is blind to runInTree");
  assert.equal(codeOnly('git(["show", `origin/main:${rel(a)}`]); // main'), 'git(["",  rel(a) ""]); ', "only code is left");

  const pass = loopReachable(fns, "runSreLanePass");
  assert.ok(pass.has("stageFeedbackCapture") && pass.has("readLandedFeedbackEntry"), "the pass reaches its staging capture and its landed read");
  for (const seed of ["runSreLanePass", "daemonSreLaneInput"]) {
    const reach = loopReachable(fns, seed);
    assert.deepEqual(SYNC_PREFLIGHT_CHAIN.filter((name) => reach.has(name)), [], `${seed} reaches the synchronous plan-PR preflight`);
  }
});

/** W1-T9696: daemon-loop captures that now stage for the async sweep, and so never name captureFeedback. */
const STAGED_CAPTURE_SEEDS = ["pollIssues", "pollAlerts", "productionIssueRevalidationPorts", "feedbackEvidenceCoverageFiler"] as const;

test("W1-T9696: the staged daemon-loop captures reach no inline captureFeedback", () => {
  const fns = censusFunctions();
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
  const fns = censusFunctions();
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
  const fns = censusFunctions();
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
  const fns = censusFunctions();
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
  const fns = censusFunctions();
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
