/**
 * W1-T13204 — no NEW serve route path reaches a synchronous spawn.
 *
 * On 2026-11-16 an Inbox write route reached a synchronous `git ls-tree` per draft path and froze serve's loop
 * for 887 s. The daemon has had this census since W1-T5689; this one seeds the same shared walk from
 * `buildServeRoutes`, which assembles every serve route. Population and EXACTNESS are the daemon census's:
 * a reachable name absent from SERVE_SYNC_SPAWN_ROUTE_BASELINE, a count above its row and a count below its
 * row all fail. The reach is name-based, an upper bound, which is acceptable for a ratchet.
 */
// @source-text-subject: src/**/*.ts — the claim is a property of EVERY function a serve route can reach,
// including paths no single request drives; the same shape as the daemon-loop census.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { loopCensusFunctions, loopReachable, type Fn } from "#test/helpers/daemon-loop-walk.js";

const BASELINE_FILE = "test/no-serve-route-path-reaches-a-synchronous-spawn.test.ts";
const DAEMON_CENSUS_FILE = "test/no-daemon-loop-path-reaches-a-synchronous-spawn.test.ts";

/** Serve-route-reachable functions that call a synchronous spawn primitive, with the count at build time. */
const SERVE_SYNC_SPAWN_ROUTE_BASELINE: Readonly<Record<string, number>> = {
  applyGhReadCadence: 1,
  assertOpenWeightToolBoundary: 1,
  assertWorkerEgressEnforcerVersion: 1,
  authorBaseRef: 1,
  baseBranchRequiresMergeQueue: 1,
  blockingSleep: 1,
  buildBatchedGithub: 1,
  buildCommitTrailerIndex: 1,
  buildProofAmendmentWritePorts: 2,
  buildSweepEffects: 5,
  changeView: 1,
  changedShardProofs: 2,
  checkCliFreshness: 1,
  checkProofAtAuthorTime: 1,
  codeScanningJudgeDeps: 1,
  couldBeInterpolatedTitle: 1,
  createGhCallPacer: 1,
  createHeadRehomePorts: 1,
  creditEvidenceRootFor: 1,
  currentBranch: 1,
  defaultBinaryPinDeps: 1,
  defaultBlockingSleepSync: 1,
  defaultBranchIsLiveUpstream: 1,
  defaultCanExecute: 1,
  defaultCiAnnotationFetch: 1,
  defaultCiJobLogFetch: 1,
  defaultCountBehind: 1,
  defaultDepReviewPrMutations: 2,
  defaultDirtyFleetRebaseGit: 1,
  defaultExec: 2,
  defaultExecutor: 1,
  defaultGetProcessStartTime: 1,
  defaultGh: 1,
  defaultGhExec: 2,
  defaultGit: 4,
  defaultGitCapture: 1,
  defaultInstallDependencies: 1,
  defaultLaneListGit: 1,
  defaultListCandidates: 1,
  defaultListProcesses: 1,
  defaultOpenFileCount: 1,
  defaultOriginOf: 1,
  defaultPlanRepairGit: 1,
  defaultProbeLiveGitProcess: 1,
  defaultProofRunner: 1,
  defaultPsGroupListing: 1,
  defaultPushExec: 2,
  defaultReadMarkers: 1,
  defaultReadRemoteHead: 1,
  defaultReconGhExec: 1,
  defaultRegistryLockSleep: 1,
  defaultRetroDiffText: 1,
  defaultRetroFetchBody: 1,
  defaultRevListCanonicalBehind: 1,
  defaultRunInstall: 1,
  defaultSecurityRunner: 1,
  defaultSleepSyncMs: 1,
  defaultSweepGhRun: 1,
  defaultSynthesizeGhExec: 1,
  defaultSynthesizeGitExec: 1,
  defaultUpstreamGh: 1,
  defaultUpstreamGit: 1,
  defaultWhich: 1,
  depReviewCommand: 3,
  discoverLiveLedgerRoot: 1,
  draftProposalBatch: 1,
  ensureDeps: 1,
  ensureInstallFresh: 1,
  ensureTaskTrailer: 2,
  ensureWorktreeConfigEnabled: 2,
  execGhPrReview: 1,
  execWhitelistedProof: 1,
  executeWorktreeRemoval: 1,
  extractReviewFindings: 1,
  fetchNewestPrReview: 1,
  fetchPrBodyViaGh: 1,
  fetchPrDiffFilesViaGh: 1,
  fetchPrLifecycle: 1,
  fileLine: 1,
  fixRebaseMergeFactsFromRest: 2,
  fixRungCiFailures: 1,
  ghExec: 4,
  ghExecFile: 4,
  ghIssueGateway: 1,
  ghJson: 2,
  ghLiveHead: 1,
  ghLiveState: 1,
  ghLiveStateByNumber: 1,
  ghPrHeadGateway: 1,
  ghPrMergeSquash: 1,
  ghPrView: 1,
  ghUpdateBranch: 2,
  git: 1,
  gitFailureReason: 1,
  gitGrepAnchorTrue: 1,
  grepFilesContaining: 1,
  handedOffHeadRiskJudge: 1,
  hostWorktreeGit: 1,
  installPinnedChromium: 1,
  isPrMergedNow: 1,
  listRegisteredWorktrees: 1,
  loadPlanAtRef: 1,
  localBranchExists: 1,
  localMergeSpawn: 1,
  main: 5,
  materializeReviewerSnapshot: 1,
  mergeBaseFor: 1,
  mergeDirectViaRest: 1,
  mergeShaNow: 1,
  originUrlAtCut: 1,
  pinnedConfigValue: 1,
  planPrPreflightAtCommit: 1,
  planSafetyGitSync: 1,
  postReviewPending: 1,
  probeProofSandbox: 1,
  proofRepairRoundRefusalInWorktree: 1,
  pruneStaleRuns: 3,
  publishAbandonedFixOwnerAhead: 1,
  readHeadShaRest: 2,
  readLocalOriginRefHead: 1,
  readMergeSubjectsByPr: 1,
  readMergedPathsByPr: 1,
  readMutationVerdictZip: 1,
  readRequiredStatusCheckContexts: 1,
  readTaskPrecondition: 1,
  readyDraftViaGh: 1,
  realArmDeps: 7,
  realDeployDeps: 1,
  realReviewWorktree: 1,
  realSharedPauseGitDeps: 1,
  reapBranchesSteps: 1,
  redBaseRefreshFactsFromRest: 1,
  refreshProofToolchain: 1,
  registeredFixWorktreeOwner: 1,
  renumberPlanPrIds: 1,
  repairPrMetadata: 2,
  replyRefusal: 1,
  requeueActionsJobOutcome: 1,
  reservationBaselineIds: 1,
  reservationPolicyCurrency: 1,
  resolveClaudeBin: 1,
  resolveCodexBin: 1,
  resolveCommitAssignment: 1,
  resolveConsoleSha: 1,
  resolveMergeLogReadOptions: 1,
  resolveOwnerRepoAt: 1,
  reuseDonor: 1,
  reviewCommand: 1,
  reviewCommandHost: 2,
  run: 1,
  runGhPrCreate: 1,
  runInTree: 1,
  runNpmScriptViaSpawn: 1,
  runPrewarmChannelsSync: 1,
  runReview: 1,
  runTaskBody: 2,
  serviceGit: 1,
  sleepSync: 3,
  sourceGit: 1,
  sourceRepositoryFromCwd: 1,
  spawnPreparedProofSync: 1,
  stackPrerequisiteFromRest: 1,
  startCheckSync: 1,
  sweepPostFixReverification: 1,
  syncPlanFromOrigin: 2,
  taskIdDeclarationsAtRef: 1,
  taskIdOwnershipFindings: 1,
  testSlotProcessFacts: 1,
  vetPinnedConfig: 1,
  worktreeAdd: 5,
  worktreePushExec: 1,
  writePrBodyRest: 1,
};

/** Repeated verbatim from the W1-T5689 census; the guard test below fails when the two differ. */
const SYNC_SPAWN_CALL =
  /\b(?:execFileSync|spawnSync|execSync|ghExec|ghExecFile|ghJson|defaultBlockingSleepSync)\(|\bAtomics\.wait\(/g;

const SYNC_SPAWN_VALUE =
  /(?:(?<![=!<>])=|\?\?|\|\||[(,:])\s*(?:execFileSync|spawnSync|execSync|ghExec|ghExecFile|ghJson|defaultBlockingSleepSync)(?![\w$])(?!\s*\()/g;

function syncSpawnCalls(fn: Fn): number {
  const defines = /^(?:export\s+)?function\s+defaultBlockingSleepSync\(/.test(fn.body) ? 1 : 0;
  return (fn.body.match(SYNC_SPAWN_CALL) ?? []).length + (fn.body.match(SYNC_SPAWN_VALUE) ?? []).length - defines;
}

function population(fns: Fn[]): Map<string, number> {
  const pop = new Map<string, number>();
  for (const f of fns) {
    const n = syncSpawnCalls(f);
    if (n > 0) pop.set(f.name, (pop.get(f.name) ?? 0) + n);
  }
  return pop;
}

/** Every serve-reachable name whose count differs from its row. */
function refusals(fns: Fn[], baseline: Readonly<Record<string, number>>): string[] {
  const reach = loopReachable(fns, "buildServeRoutes");
  const pop = population(fns);
  const names = new Set([...pop.keys()].filter((n) => reach.has(n)));
  for (const n of Object.keys(baseline)) names.add(n);
  const out: string[] = [];
  for (const name of [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const count = reach.has(name) ? pop.get(name) ?? 0 : 0;
    const row = Object.hasOwn(baseline, name) ? baseline[name]! : undefined;
    const file = fns.find((f) => f.name === name)?.file ?? "(unknown file)";
    if (row === undefined) {
      out.push(`${name} (${file}) makes ${count} synchronous spawn call(s) and is reachable from a serve route (buildServeRoutes), but is not in SERVE_SYNC_SPAWN_ROUTE_BASELINE — convert the site to an async seam`);
    } else if (count > row) {
      out.push(`${name} (${file}) makes ${count} synchronous spawn call(s) on a serve route, above its SERVE_SYNC_SPAWN_ROUTE_BASELINE row of ${row} — convert the site to an async seam`);
    } else if (count < row) {
      out.push(`${name} (${file}) makes ${count} synchronous spawn call(s) on a serve route < row ${row} — lower SERVE_SYNC_SPAWN_ROUTE_BASELINE \`${name}\` to ${count} (or delete it at 0) in ${BASELINE_FILE} in this PR`);
    }
  }
  return out;
}

test("census: the serve seed is real, so the walk cannot pass vacuously", () => {
  const fns = loopCensusFunctions();
  assert.ok(fns.some((f) => f.name === "buildServeRoutes"), "the walk must find buildServeRoutes to seed from");
  const reach = loopReachable(fns, "buildServeRoutes");
  assert.ok(reach.size > 50, `buildServeRoutes must reach a real population; saw ${reach.size}`);
  assert.ok(population(fns).size > 100, "the scan must see sync-spawning functions across src");
});

test("unit test: W1-T13204 criterion 1 in test/no-serve-route-path-reaches-a-synchronous-spawn.test.ts — the census holds the serve reach to SERVE_SYNC_SPAWN_ROUTE_BASELINE", () => {
  const fns = loopCensusFunctions();
  assert.deepEqual(refusals(fns, SERVE_SYNC_SPAWN_ROUTE_BASELINE), [], "a serve route path reaches a synchronous spawn outside the table");
});

test("unit test: W1-T13204 criterion 2 in test/no-serve-route-path-reaches-a-synchronous-spawn.test.ts — missing row, growth and slack each name function, file and fix", () => {
  const fns = loopCensusFunctions();
  const reach = loopReachable(fns, "buildServeRoutes");
  const pop = population(fns);
  const rowed = Object.keys(SERVE_SYNC_SPAWN_ROUTE_BASELINE);

  // A reachable function with no row gains a spawn: named with its file and the fix.
  const target = fns.find((f) => reach.has(f.name) && !pop.has(f.name))!;
  const planted = fns.map((f) => (f === target ? { ...f, body: f.body + '\n  execFileSync("git", ["fetch"]);' } : f));
  const missing = refusals(planted, SERVE_SYNC_SPAWN_ROUTE_BASELINE);
  assert.equal(missing.length, 1);
  assert.ok(missing[0]!.startsWith(`${target.name} (${target.file}) makes 1 synchronous spawn call(s)`), missing[0]);
  assert.match(missing[0]!, /not in SERVE_SYNC_SPAWN_ROUTE_BASELINE — convert the site/);

  if (rowed.length > 0) {
    const name = rowed[0]!;
    const row = SERVE_SYNC_SPAWN_ROUTE_BASELINE[name]!;
    const grown = refusals(fns.map((f) => (f.name === name ? { ...f, body: f.body + '\n  spawnSync("git");' } : f)), SERVE_SYNC_SPAWN_ROUTE_BASELINE);
    assert.equal(grown.length, 1);
    assert.match(grown[0]!, new RegExp(`^${name} \\(.+\\) makes ${row + 1} synchronous spawn call\\(s\\) on a serve route, above its SERVE_SYNC_SPAWN_ROUTE_BASELINE row of ${row} — convert the site`));
    const slack = refusals(fns, { ...SERVE_SYNC_SPAWN_ROUTE_BASELINE, [name]: row + 3 });
    assert.equal(slack.length, 1);
    assert.match(slack[0]!, new RegExp(`^${name} \\(.+\\) makes ${row} synchronous spawn call\\(s\\) on a serve route < row ${row + 3} — lower SERVE_SYNC_SPAWN_ROUTE_BASELINE`));
  }
  // A row for a name no route reaches counts 0 and must be deleted.
  const ghost = refusals(fns, { ...SERVE_SYNC_SPAWN_ROUTE_BASELINE, noSuchFunctionAnywhere: 1 });
  assert.equal(ghost.length, 1);
  assert.match(ghost[0]!, /^noSuchFunctionAnywhere .* < row 1 — lower SERVE_SYNC_SPAWN_ROUTE_BASELINE `noSuchFunctionAnywhere` to 0 \(or delete it at 0\)/);
});

test("unit test: W1-T13204 criterion 3 in test/no-serve-route-path-reaches-a-synchronous-spawn.test.ts — the primitive patterns equal the W1-T5689 census's", () => {
  const daemon = readFileSync(join(REPO_ROOT, DAEMON_CENSUS_FILE), "utf8");
  const grab = (name: string): string => {
    const m = new RegExp(`const ${name} =\\s*\\n?\\s*/(.+)/g;`).exec(daemon);
    assert.ok(m, `${DAEMON_CENSUS_FILE} must still define ${name}`);
    return m[1]!;
  };
  assert.equal(SYNC_SPAWN_CALL.source, new RegExp(grab("SYNC_SPAWN_CALL")).source, "SYNC_SPAWN_CALL differs from the daemon census");
  assert.equal(SYNC_SPAWN_VALUE.source, new RegExp(grab("SYNC_SPAWN_VALUE")).source, "SYNC_SPAWN_VALUE differs from the daemon census");
});
