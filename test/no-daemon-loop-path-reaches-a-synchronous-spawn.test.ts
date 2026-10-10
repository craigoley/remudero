/**
 * W1-T5689 — no NEW daemon-loop path reaches a synchronous spawn.
 *
 * A synchronous `execFileSync`/`spawnSync`/`execSync` (or the sync `ghExec`/`ghJson`, or a blocking
 * `Atomics.wait` sleep) called anywhere on the daemon loop's reach freezes the event loop for as long as
 * the child runs. Every stall so far (the 51 min of 2026-10-04, the 54 min review hang of 2026-10-03) was
 * fixed ONE SITE AT A TIME after it was measured live; test/gh-transport-census asks where `gh` is spawned,
 * not whether the loop can reach it. This census refuses the NEXT reachable site before it ships.
 *
 * Population: every top-level function (declaration or arrow const) whose comment-stripped body calls a
 * synchronous spawn primitive. Reach: the name-based fixed point of test/no-daemon-loop-path-builds-the-
 * unbatched-gateway, seeded from `daemonCommand` (its DaemonDeps literal and the hook builders). Baseline:
 * SYNC_SPAWN_LOOP_BASELINE, {functionName: count} recorded at build time. The census fails only on a
 * reachable name ABSENT from the table or a count ABOVE its row, so the converters (W1-T5282, W1-T5284,
 * W1-T4970, W1-T5672) shrink the population without touching this file.
 */
// @source-text-subject: src/**/*.ts — the claim is a property of EVERY function the loop can reach,
// including paths no single execution drives; the same shape as test/gh-transport-census.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/** Loop-reachable functions that still call a synchronous spawn primitive, with the call count recorded
 *  at build time (2026-10-10, f49ee17d3). A new name, or a count above its row, fails the census; a
 *  count BELOW its row passes, so converting a site never needs an edit here. */
const SYNC_SPAWN_LOOP_BASELINE: Readonly<Record<string, number>> = {
  applyDefuseActions: 1,
  assertWorkerEgressEnforcerVersion: 1,
  assessedReviewerFreshness: 1,
  authorBaseRef: 1,
  blobShaAtRef: 1,
  blockingSleep: 1,
  buildBatchedGithub: 1,
  buildCommitTrailerIndex: 1,
  buildRegisteredGarden: 1,
  buildSweepEffects: 4,
  changedShardProofs: 2,
  checkCliFreshness: 1,
  checkProofAtAuthorTime: 1,
  ciFrictionGardenSpec: 1,
  ciLearningTaskIdMinter: 1,
  classifyHeadShaAvailability: 1,
  codeScanningJudgeDeps: 1,
  couldBeInterpolatedTitle: 1,
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
  depReviewCommand: 1,
  discoverLiveLedgerRoot: 1,
  dispatchClaimReserverFor: 1,
  draftProposalBatch: 1,
  ensureInstallFresh: 1,
  ensureTaskTrailer: 1,
  ensureWorktreeConfigEnabled: 2,
  execGhPrReview: 1,
  execGhStatusPost: 1,
  executeWorktreeRemoval: 2,
  extractReviewFindings: 1,
  fetchMergedCoverageArtifact: 4,
  fileLine: 1,
  filingRef: 1,
  fixRungCiFailures: 1,
  flowGardenSpec: 2,
  gardenCheckout: 2,
  gateGardenSpec: 1,
  ghAlertGateway: 1,
  ghEscalationAnswerGateway: 1,
  ghExec: 4,
  ghExecFile: 4,
  ghGateway: 1,
  ghIssueGateway: 1,
  ghIssueListGateway: 1,
  ghJson: 1,
  ghLiveState: 1,
  ghPrMergeSquash: 1,
  ghPrView: 1,
  git: 1,
  gitFailureReason: 1,
  gitGrepAnchorTrue: 1,
  grepFilesContaining: 1,
  grepProofHeldAt: 1,
  grepProofHolds: 1,
  hostWorktreeGit: 1,
  hotFileGardenSpec: 1,
  idCitedInSrc: 1,
  imessageChannel: 1,
  installPinnedChromium: 1,
  isGitWorktree: 1,
  ladderGardenSpec: 2,
  listRegisteredWorktrees: 1,
  listRuleSuites: 1,
  loadPlanAtRef: 1,
  localBranchExists: 1,
  localMergeSpawn: 1,
  main: 5,
  mainRecords: 1,
  mainTrailerTaskIds: 1,
  manifestLastCommitMs: 1,
  materializeReviewerSnapshot: 1,
  mergeBaseFor: 1,
  mergedPrsSince: 1,
  mergedTriageSubjects: 1,
  opportunityIntakePortsOver: 2,
  originUrlAtCut: 1,
  pinnedConfigValue: 1,
  planPrPreflightAtCommit: 2,
  planReloader: 1,
  planSafetyGitSync: 1,
  planTreeIsBehindMain: 1,
  preserveFixHead: 3,
  productionCiJudgePorts: 1,
  productionGardenerOverseerPorts: 1,
  projectionGithub: 1,
  proofLandingCommit: 1,
  proofRepairRoundRefusalInWorktree: 1,
  pruneStaleRuns: 4,
  publishAbandonedFixOwnerAhead: 1,
  readAffectedListings: 1,
  readAffectedSuitesInput: 1,
  readCheckoutDepth: 2,
  readCiFrictionHandFixes: 2,
  readCiFrictionPlanState: 1,
  readCodeScanningAlerts: 1,
  readDispatchFilingSnapshot: 1,
  readLocalOriginRefHead: 1,
  readMainHistory: 1,
  readMergeSubjectsByPr: 1,
  readMergedPathsByPr: 1,
  readMutationVerdictZip: 1,
  readOperatorInterventions: 2,
  readOutcomes: 1,
  readLadderPlan: 1,
  readRequiredStatusCheckContexts: 1,
  realArmDeps: 4,
  realDeployDeps: 1,
  realSharedPauseGitDeps: 1,
  reapBranchesSteps: 1,
  refCommitMatchesDirtyRecovery: 3,
  referencesOutside: 1,
  refreshKnowledgeAssertions: 2,
  registeredFixWorktreeOwner: 1,
  remotePlanCeilingOnRef: 1,
  removeAbandonedFixWorktreeOwner: 1,
  removeBaseProofWorktree: 1,
  repairPrMetadata: 2,
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
  reviewerGit: 1,
  run: 1,
  runMachineFilingJudge: 1,
  runNpmScriptViaSpawn: 1,
  runPrewarmChannelsSync: 1,
  runSuiteShifted: 1,
  runTaskBody: 2,
  serviceGit: 1,
  shardAgeDays: 1,
  sleepSync: 3,
  sourceRepositoryFromCwd: 1,
  spawnPreparedProofSync: 1,
  sreOperatorEscalation: 1,
  startCheckSync: 1,
  sweepPostFixReverification: 1,
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

/** Column-0 function declarations (generators included) and column-0 arrow consts; a body runs to the
 *  next column-0 declaration (a closing brace at column 0 is NOT a boundary: a multi-line parameter type
 *  closes with one). */
function topLevelFunctions(): Fn[] {
  const fns: Fn[] = [];
  const decl =
    /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/;
  const NEXT_DECL = /^(?:export\s+|declare\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum|abstract)\b|^export\s/;
  for (const file of trackedSourceFiles()) {
    const lines = stripComments(readFileSync(new URL(`../${file}`, import.meta.url), "utf8")).split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = decl.exec(lines[i]!);
      if (!m) continue;
      let end = i + 1;
      while (end < lines.length && !NEXT_DECL.test(lines[end]!)) end++;
      fns.push({ name: (m[1] ?? m[2])!, file, body: lines.slice(i, end).join("\n") });
    }
  }
  return fns;
}

/** A synchronous spawn or block: the node primitives, the sync gh wrappers (`ghJsonAsync`/`ghExecAsync`
 *  do not match — the `(` must follow the name), the blocking sleep, and `Atomics.wait`. */
const SYNC_SPAWN_CALL =
  /\b(?:execFileSync|spawnSync|execSync|ghExec|ghExecFile|ghJson|defaultBlockingSleepSync)\(|\bAtomics\.wait\(/g;

/** Calls in one body; the sleep's own definition is not a call site. */
function syncSpawnCalls(fn: Fn): number {
  const defines = /^(?:export\s+)?function\s+defaultBlockingSleepSync\(/.test(fn.body) ? 1 : 0;
  return (fn.body.match(SYNC_SPAWN_CALL) ?? []).length - defines;
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

/** Synchronous-spawn calls per function NAME (same-named functions in different files sum). */
function population(fns: Fn[]): Map<string, number> {
  const pop = new Map<string, number>();
  for (const f of fns) {
    const n = syncSpawnCalls(f);
    if (n > 0) pop.set(f.name, (pop.get(f.name) ?? 0) + n);
  }
  return pop;
}

function refusals(fns: Fn[], baseline: Readonly<Record<string, number>>): string[] {
  const reach = loopReachable(fns, "daemonCommand");
  const out: string[] = [];
  for (const [name, count] of [...population(fns)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!reach.has(name)) continue;
    if (!(name in baseline)) {
      out.push(`${name} makes ${count} synchronous spawn call(s) and is reachable from the daemon loop (daemonCommand), but is not in SYNC_SPAWN_LOOP_BASELINE — await an async seam instead`);
    } else if (count > baseline[name]!) {
      out.push(`${name} makes ${count} synchronous spawn call(s) on the daemon loop, above its SYNC_SPAWN_LOOP_BASELINE row of ${baseline[name]} — await an async seam instead`);
    }
  }
  return out;
}

test("census: the seed and the population are real, so the walk cannot pass vacuously", () => {
  const fns = topLevelFunctions();
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
  const fns = topLevelFunctions();
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

  // A function the loop does NOT reach may spawn freely (CLI-only), and shrinking a row never fails.
  const offLoop = [...fns, { name: "someCliOnlyVerb", file: "x", body: 'function someCliOnlyVerb() { execSync("x"); }' }];
  assert.deepEqual(refusals(offLoop, SYNC_SPAWN_LOOP_BASELINE), []);
  assert.deepEqual(refusals(fns, { ...SYNC_SPAWN_LOOP_BASELINE, syncPlanFromOrigin: 9 }), []);
});

test("an emptied population scan fails the positive control", () => {
  const fns = topLevelFunctions();
  const blind = fns.map((f) => ({ ...f, body: f.body.replace(SYNC_SPAWN_CALL, "noop(") }));
  assert.ok(!population(blind).has("syncPlanFromOrigin"), "a scan that matches nothing finds no population");
  assert.ok(population(fns).has("syncPlanFromOrigin"), "the real scan finds the positive control");
});

test("the baseline records only positive counts for real functions", () => {
  const names = new Set(topLevelFunctions().map((f) => f.name));
  for (const [name, count] of Object.entries(SYNC_SPAWN_LOOP_BASELINE)) {
    assert.ok(Number.isInteger(count) && count > 0, `${name} must carry a positive count`);
    assert.ok(names.has(name), `${name} no longer exists — delete its baseline row`);
  }
});
