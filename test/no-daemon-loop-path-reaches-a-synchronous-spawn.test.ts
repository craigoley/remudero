/**
 * W1-T5689 — no NEW daemon-loop path reaches a synchronous spawn.
 *
 * A synchronous spawn (`execFileSync`, `spawnSync`, `execSync`, `ghExec`, `ghExecFile`, `ghJson(`,
 * `Atomics.wait`, `defaultBlockingSleepSync`) blocks the daemon's event loop for as long as the child
 * runs. Each loop stall so far was fixed one site at a time AFTER it was measured live. The only other
 * census (test/gh-transport-census) asks where `gh` is spawned, not whether the loop can reach it.
 *
 * CENSUS: the population is every function whose comment-stripped body makes one of those calls; loop
 * reach is the name-based fixed point of test/no-daemon-loop-path-builds-the-unbatched-gateway, seeded
 * from `daemonCommand` (its DaemonDeps literal and the hook builders it calls). The recorded baseline
 * `SYNC_SPAWN_LOOP_BASELINE` is {functionName: count}; the test fails only on a reachable name absent
 * from the table or a count above its row. Converting a site to async only LOWERS a count, so the
 * converters (W1-T5282, W1-T5284, W1-T4970) shrink the table without needing to touch this file.
 */
// @source-text-subject: src/**/*.ts — the claim is a property of EVERY function in src, including
// paths no single execution drives; the same shape as test/gh-transport-census.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/** Loop-reachable synchronous spawn calls per function name, recorded at build time (W1-T5689).
 *  RATCHET: a reachable function absent from this table, or above its row, fails the census. */
const SYNC_SPAWN_LOOP_BASELINE: Readonly<Record<string, number>> = {
  appendTaskTrailerToCommit: 4,
  applyDefuseActions: 1,
  applyGhReadCadence: 1,
  assertReviewerSnapshotIntegrity: 2,
  assertWorkerEgressEnforcerVersion: 1,
  authorBaseRef: 1,
  blobShaAtRef: 1,
  blockingSleep: 1,
  buildBaseProofDir: 4,
  buildBatchedGithub: 1,
  buildCommitTrailerIndex: 1,
  buildRegisteredGarden: 1,
  buildSweepEffects: 6,
  captureRegisteredFixOwnerSnapshot: 6,
  captureWorktreeSnapshotViaGit: 3,
  changedShardProofs: 2,
  checkCliFreshness: 1,
  checkProofAtAuthorTime: 1,
  checkoutFixHeadRef: 7,
  ciFrictionGardenSpec: 1,
  ciLearningTaskIdMinter: 1,
  classifyHeadShaAvailability: 1,
  codexGitWritableRoots: 1,
  commitGeneratorOutputViaGit: 6,
  commitWorkerEdits: 2,
  commitsAhead: 1,
  couldBeInterpolatedTitle: 1,
  createGhCallPacer: 1,
  credentialHelperSocketWired: 1,
  creditEvidenceRootFor: 1,
  currentBranch: 1,
  daemonCommand: 4,
  daemonSreRunbookHost: 4,
  dedicatedTargetPlanReloader: 3,
  defaultAdoptionShipDate: 1,
  defaultBinaryPinDeps: 1,
  defaultBlockingSleepSync: 1,
  defaultBranchIsLiveUpstream: 1,
  defaultCanExecute: 1,
  defaultCiAnnotationFetch: 1,
  defaultCiJobLogFetch: 1,
  defaultCountBehind: 1,
  defaultCountDirtyFiles: 1,
  defaultCountPrunable: 1,
  defaultCoverageArtifactGhBuffer: 1,
  defaultCoverageArtifactGhJson: 1,
  defaultDepReviewPrMutations: 2,
  defaultDirtyFleetRebaseGit: 1,
  defaultEmailSpawn: 1,
  defaultExec: 2,
  defaultExecutor: 1,
  defaultGetProcessStartTime: 1,
  defaultGh: 1,
  defaultGhExec: 1,
  defaultGit: 4,
  defaultGitCapture: 1,
  defaultInstallDependencies: 1,
  defaultIsInUse: 1,
  defaultLaneListGit: 1,
  defaultListCandidates: 1,
  defaultListWorktrees: 1,
  defaultLooseObjectCount: 1,
  defaultMeasurementCadenceGitLog: 2,
  defaultMergeEvidenceLog: 2,
  defaultOpenFileCount: 1,
  defaultOriginOf: 1,
  defaultPlanRepairGit: 1,
  defaultProbeLiveGitProcess: 1,
  defaultProofRunner: 1,
  defaultPsGroupListing: 1,
  defaultPushExec: 2,
  defaultReadDispatchClaims: 2,
  defaultReadHeadSha: 1,
  defaultReadMarkers: 1,
  defaultReadPushedRunBranches: 1,
  defaultReadRemoteHead: 1,
  defaultReadRemoteHeadSha: 1,
  defaultRegistryLockSleep: 1,
  defaultResolveOriginMainSha: 1,
  defaultRetroFetchBody: 1,
  defaultRevListCanonicalBehind: 1,
  defaultRunInstall: 1,
  defaultSizeBytes: 1,
  defaultSleepSyncMs: 1,
  defaultSweepGhRun: 1,
  defaultUpstreamGh: 1,
  defaultUpstreamGit: 1,
  defaultWhich: 1,
  defuseCandidates: 1,
  depReviewCommand: 1,
  discoverLiveLedgerRoot: 1,
  dispatchClaimReserverFor: 1,
  draftProposalBatch: 1,
  ensureInstallFresh: 1,
  ensureTaskTrailer: 1,
  ensureWorktreeConfigEnabled: 2,
  excludeNodeModulesFromGit: 1,
  execGhPrReview: 1,
  execGhStatusPost: 1,
  executeWorktreeRemoval: 2,
  extractReviewFindings: 1,
  fetchMergedCoverageArtifact: 4,
  fileLine: 1,
  filingRef: 1,
  fillDerivedBody: 3,
  gardenCheckout: 2,
  gateGardenSpec: 1,
  ghAlertGateway: 1,
  ghEscalationAnswerGateway: 1,
  ghExec: 1,
  ghExecFile: 1,
  ghGateway: 1,
  ghIssueGateway: 1,
  ghIssueListGateway: 1,
  ghLiveState: 1,
  ghPrMergeSquash: 1,
  ghPrView: 1,
  git: 1,
  gitAddAndCommitWithRollback: 4,
  gitFailureReason: 1,
  gitGrepAnchorTrue: 1,
  gitHeartbeatSource: 1,
  gitProbe: 1,
  grepFilesContaining: 1,
  grepProofHeldAt: 1,
  grepProofHolds: 1,
  headIsInWorktree: 1,
  headProvenanceFields: 1,
  hotFileGardenSpec: 1,
  idCitedInSrc: 1,
  imessageChannel: 1,
  installPinnedChromium: 1,
  irreversibleSignalForWorktree: 1,
  isGitWorktree: 1,
  laneSizeBytes: 1,
  laneWorkKeepReason: 4,
  lastCommitSubject: 1,
  lintPlanCommand: 4,
  lintPlanForReview: 1,
  lintScopeMergeBase: 1,
  listRegisteredWorktrees: 1,
  loadPlanAtRef: 1,
  localBranchExists: 1,
  localMergeSpawn: 1,
  main: 6,
  mainRecords: 1,
  mainTrailerTaskIds: 1,
  manifestLastCommitMs: 1,
  materializeReviewerSnapshot: 4,
  mergeBaseFor: 1,
  mergedInLastDay: 1,
  mergedPrsSince: 1,
  mergedTriageSubjects: 1,
  missingCommitLinePrompt: 2,
  newMonolithIdsAgainstBase: 2,
  opportunityIntakePortsOver: 2,
  planCriteriaAtHeadForRepair: 2,
  planReloader: 1,
  planRepairGitRun: 1,
  planSafetyGitSync: 1,
  planTreeIsBehindMain: 1,
  preserveFixHead: 3,
  preserveTrackedDirtyFixOwner: 7,
  productionGardenerOverseerPorts: 1,
  projectionGithub: 1,
  proofLandingCommit: 1,
  proofRepairRoundRefusalInWorktree: 2,
  pruneStaleRuns: 4,
  publishAbandonedFixOwnerAhead: 1,
  readAffectedSuitesInput: 1,
  readBaselineRatchetWorktreeState: 3,
  readCheckoutDepth: 2,
  readCiFrictionHandFixes: 2,
  readCiFrictionPlanState: 1,
  readCodeScanningAlerts: 1,
  readDispatchFilingSnapshot: 1,
  readFixRoundCommitsViaGit: 3,
  readLocalOriginRefHead: 1,
  readMainHistory: 1,
  readMergeSubjectsByPr: 1,
  readMergedPathsByPr: 1,
  readMutationVerdictZip: 1,
  readRequiredStatusCheckContexts: 1,
  readWorktreeHeadReflog: 1,
  realArmDeps: 4,
  realDeployDeps: 1,
  realSharedPauseGitDeps: 1,
  reapBranchesCommand: 1,
  reapGitObjects: 1,
  refCommitMatchesDirtyRecovery: 3,
  referencesOutside: 1,
  refreshKnowledgeAssertions: 2,
  refreshManagedCheckout: 1,
  registeredFixWorktreeOwner: 1,
  remotePlanCeilingOnRef: 1,
  removeAbandonedFixWorktreeOwner: 1,
  removeBaseProofWorktree: 1,
  repairCensusRefusedPush: 2,
  repairPrMetadata: 2,
  reservationBaselineIds: 1,
  resetTrackedDirtyFixOwner: 1,
  resolveClaudeBin: 1,
  resolveCodexBin: 1,
  resolveCommitAssignment: 1,
  resolveMergeLogReadOptions: 1,
  resolveOwnerRepoAt: 1,
  resolvePlanCriteriaAtHead: 1,
  resolveReviewSubjectCheckout: 1,
  retroShippedGithubGateway: 1,
  reviewerFreshnessFromService: 1,
  reviewerGit: 1,
  run: 1,
  runAutomaticBranchReapRung: 1,
  runFixRung: 5,
  runMachineFilingJudge: 1,
  runNpmScriptViaSpawn: 1,
  runPlanScopedFixRound: 1,
  runPrewarmChannelsSync: 1,
  runReview: 2,
  runShardRepairPass: 1,
  runTaskBody: 8,
  serviceGit: 1,
  shardAgeDays: 1,
  sleepSync: 2,
  sourceRepositoryFromCwd: 1,
  sreOperatorEscalation: 1,
  stampRunWorktreeAssignment: 1,
  startShellLessMergeConflictMerge: 1,
  sweepPostFixReverification: 1,
  syncPlanFromOrigin: 2,
  taskIdDeclarationsAtRef: 1,
  taskIdOwnershipFindings: 1,
  taskIdsEverFiled: 1,
  temporaryIndexTree: 2,
  triageClaimReserverFor: 1,
  triageCommandLocked: 9,
  updateBranchViaGh: 1,
  wireCredentialHelperSocket: 1,
  workerCreatedCurrentHead: 1,
  worktreeAdd: 4,
  worktreeChangedFiles: 1,
  worktreeHasUncommittedChanges: 1,
  worktreeMergeBase: 1,
  worktreeRemove: 1,
  writePrBodyRest: 1,
};

interface Fn {
  name: string;
  file: string;
  body: string;
}

/** Blank comment lines, keeping line numbers. Block comments are recognised only where they START a
 *  line: a naive `/\*...\*\/` regex also fires on glob strings such as "src/**\/*.ts" and swallows code. */
function stripComments(source: string): string {
  let inBlock = false;
  return source
    .split("\n")
    .map((line) => {
      if (inBlock) {
        if (line.includes("*/")) inBlock = false;
        return "";
      }
      if (/^\s*\/\*/.test(line)) {
        if (!line.includes("*/", line.indexOf("/*") + 2)) inBlock = true;
        return "";
      }
      return /^\s*\/\//.test(line) ? "" : line;
    })
    .join("\n");
}

function trackedSourceFiles(): string[] {
  const sub = "ls" + "-files";
  return execFileSync("git", [sub, "src/**/*.ts", "src/*.ts"], { encoding: "utf8" }).split("\n").filter(Boolean).sort();
}

/** Every column-0 function declaration; its body runs to the next column-0 declaration. */
function topLevelFunctions(): Fn[] {
  const fns: Fn[] = [];
  const decl = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/;
  const NEXT_DECL = /^(?:export\s+|declare\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum|abstract)\b|^export\s/;
  for (const file of trackedSourceFiles()) {
    const lines = stripComments(readFileSync(new URL(`../${file}`, import.meta.url), "utf8")).split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = decl.exec(lines[i]!);
      if (!m) continue;
      let end = i + 1;
      while (end < lines.length && !NEXT_DECL.test(lines[end]!)) end++;
      fns.push({ name: m[1]!, file, body: lines.slice(i, end).join("\n") });
    }
  }
  return fns;
}

/** One synchronous-spawn call. `ghJson(` does not match `ghJsonAsync(`; a declaration is not a call. */
const SYNC_SPAWN_CALL =
  /(?<!function\s)\b(?:execFileSync|spawnSync|execSync|ghExec|ghExecFile|ghJson)\s*\(|\bAtomics\.wait\s*\(|(?<!function\s)\bdefaultBlockingSleepSync\b/g;

/** Synchronous-spawn call count per function name (declarations sharing a name are summed). */
function population(fns: Fn[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of fns) {
    const n = (f.body.match(SYNC_SPAWN_CALL) ?? []).length;
    if (n > 0) out.set(f.name, (out.get(f.name) ?? 0) + n);
  }
  return out;
}

/** Name-based fixed point: a function is reachable when its identifier appears in a reachable body. */
function loopReachable(fns: Fn[], seed: string): Set<string> {
  const byName = new Map<string, Fn[]>();
  for (const f of fns) byName.set(f.name, [...(byName.get(f.name) ?? []), f]);
  const reached = new Set<string>([seed]);
  const queue = [seed];
  while (queue.length) {
    const name = queue.pop()!;
    for (const f of byName.get(name) ?? []) {
      for (const id of f.body.match(/[A-Za-z_$][\w$]*/g) ?? []) {
        if (byName.has(id) && !reached.has(id)) {
          reached.add(id);
          queue.push(id);
        }
      }
    }
  }
  return reached;
}

/** Loop-reachable population: name -> synchronous-spawn call count. */
function reachablePopulation(fns: Fn[]): Map<string, number> {
  const reach = loopReachable(fns, "daemonCommand");
  return new Map([...population(fns)].filter(([name]) => reach.has(name)));
}

function refusals(fns: Fn[], baseline: Readonly<Record<string, number>>): string[] {
  const out: string[] = [];
  for (const [name, count] of [...reachablePopulation(fns)].sort(([a], [b]) => a.localeCompare(b))) {
    if (!(name in baseline)) {
      out.push(`${name} makes ${count} synchronous spawn call(s) and is reachable from the daemon loop (daemonCommand) but is not in SYNC_SPAWN_LOOP_BASELINE — use the async transport`);
    } else if (count > baseline[name]!) {
      out.push(`${name} makes ${count} synchronous spawn call(s) on a loop-reachable path, above its SYNC_SPAWN_LOOP_BASELINE row of ${baseline[name]}`);
    }
  }
  return out;
}

test("census: the seed and the positive controls are real, so the walk cannot pass vacuously", () => {
  const fns = topLevelFunctions();
  assert.ok(fns.some((f) => f.name === "daemonCommand"), "the walk must find daemonCommand to seed from");
  const pop = population(fns);
  assert.ok(pop.has("syncPlanFromOrigin"), "positive control: syncPlanFromOrigin spawns synchronously");
  // sweepLandingSteps spawns only THROUGH defaultGit (its own body has no spawn call), so the census
  // records the spawn where it is made: defaultGit is the population member, sweepLandingSteps the path.
  const sweep = fns.find((f) => f.name === "sweepLandingSteps");
  assert.ok(sweep && /\bdefaultGit\(/.test(sweep.body), "positive control: sweepLandingSteps reaches its spawn through defaultGit");
  assert.ok(pop.has("defaultGit"), "positive control: defaultGit spawns synchronously");
  const reach = reachablePopulation(fns);
  assert.ok(reach.has("syncPlanFromOrigin"), "positive control: the loop reaches syncPlanFromOrigin");
  assert.ok(loopReachable(fns, "daemonCommand").has("sweepLandingSteps"), "positive control: the loop reaches sweepLandingSteps");
  assert.ok(reach.has("defaultGit"), "positive control: the loop reaches defaultGit's spawn");
  assert.ok(pop.size > reach.size && reach.size > 0, "reach must split the population (CLI-only sites exist)");
});

test("unit test: test/no-daemon-loop-path-reaches-a-synchronous-spawn.test.ts — the census names a fixture function in the loop reach that gains an execFileSync call", () => {
  const fns = topLevelFunctions();
  assert.deepEqual(refusals(fns, SYNC_SPAWN_LOOP_BASELINE), [], "a loop path reaches a synchronous spawn the baseline does not record");

  // Falsifier on the real source: a new sync spawn in a function the loop already reaches by name.
  const grown = fns.map((f) =>
    f.name === "syncPlanFromOrigin" ? { ...f, body: f.body + '\n  execFileSync("git", ["fetch"]);' } : f,
  );
  const above = refusals(grown, SYNC_SPAWN_LOOP_BASELINE);
  assert.equal(above.length, 1);
  assert.match(above[0]!, /^syncPlanFromOrigin makes \d+ synchronous spawn call\(s\) on a loop-reachable path, above its SYNC_SPAWN_LOOP_BASELINE row/);

  // A new function named in the loop reach (appended to a reachable body) that spawns is named too.
  const fixture: Fn = { name: "fixtureNewSpawner", file: "fixture.ts", body: 'function fixtureNewSpawner() {\n  execFileSync("git", ["fetch"]);\n}' };
  const wired = grown.map((f) => (f.name === "daemonCommand" ? { ...f, body: f.body + "\n  fixtureNewSpawner();" } : f));
  const named = refusals([...wired, fixture], SYNC_SPAWN_LOOP_BASELINE);
  assert.ok(named.some((l) => l.startsWith("fixtureNewSpawner makes 1 synchronous spawn call(s)")), named.join("\n"));

  // The same function unreached by the loop is not refused: the census is about reach, not existence.
  assert.ok(!refusals([...fns, fixture], SYNC_SPAWN_LOOP_BASELINE).some((l) => l.startsWith("fixtureNewSpawner")));
});

test("the call pattern counts each sync spawn form and skips async and declarations", () => {
  const count = (s: string): number => (s.match(SYNC_SPAWN_CALL) ?? []).length;
  assert.equal(count("execFileSync('a'); spawnSync('b'); execSync('c'); ghExec(x); ghExecFile(y); ghJson(z)"), 6);
  assert.equal(count("Atomics.wait(a, 0, 0, 5); defaultBlockingSleepSync(5)"), 2);
  assert.equal(count("await ghJsonAsync(z); function ghExec(a) {} ghExecAsync(q)"), 0);
});
