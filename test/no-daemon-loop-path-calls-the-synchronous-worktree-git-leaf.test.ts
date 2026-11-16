/**
 * W1-T12952 — no NEW daemon-loop path calls the synchronous worktree git leaf.
 *
 * `hostWorktreeGit` runs `execFileSync` twice per call (the config vet and the git command), so every call on the
 * daemon loop holds the loop for as long as git runs. The sync-spawn census
 * (test/no-daemon-loop-path-reaches-a-synchronous-spawn.test.ts) counts the primitives INSIDE the leaf, so it lists
 * none of the leaf's callers. On 2026-11-15 the filing-history reader of the lifetime-pressure route made 1,368 such
 * calls in 24 h. This census lists the callers.
 *
 * Population: every top-level function outside src/lib/worktree-git.ts whose code-only body calls `hostWorktreeGit(`
 * or hands `hostWorktreeGit` over as a value (a seam default, a fallback, an argument). Reach: the shared daemon-loop
 * walk seeded from `daemonCommand`. Baseline: SYNC_GIT_LEAF_LOOP_BASELINE, exact. A reached name with no row, a count
 * above its row and a count below its row all fail, so the table can only fall, one converted caller at a time.
 */
// @source-text-subject: src/**/*.ts — the claim is a property of EVERY function the loop can reach,
// including paths no single execution drives; the same shape as the sync-spawn census.
import assert from "node:assert/strict";
import { test } from "node:test";

import { loopCensusFunctions, loopReachable, type Fn } from "#test/helpers/daemon-loop-walk.js";

/** Loop-reachable callers of the synchronous worktree git leaf, recorded at build time (2026-11-15). */
const SYNC_GIT_LEAF_LOOP_BASELINE: Readonly<Record<string, number>> = {
  appendTaskTrailerToCommit: 4,
  assertReviewerSnapshotIntegrity: 2,
  branchDeclaredTaskIds: 1,
  branchPrTitle: 1,
  buildBaseProofDir: 4,
  buildProofAmendmentGitOps: 1,
  callSiteCandidates: 1,
  captureLocalQualificationReceipt: 3,
  captureRegisteredFixOwnerSnapshot: 4,
  captureWorktreeSnapshotViaGit: 3,
  changedProcfsWriteOffences: 1,
  checkoutFixHeadRef: 7,
  checkoutRepoFacts: 1,
  clearStaleDirtyFixOwner: 1,
  commitCodexWriterEdits: 5,
  commitGeneratorOutputViaGit: 1,
  commitWorkerEdits: 2,
  commitsAhead: 1,
  credentialHelperSocketWired: 1,
  defaultCountDirtyFiles: 1,
  defaultGit: 2,
  defaultListTree: 1,
  defaultNodePinSyncIo: 1,
  defaultReadBlob: 1,
  defaultReadHeadSha: 1,
  defaultShardGitRunner: 1,
  deferOpenToSiblingPr: 1,
  defuseCandidates: 1,
  dropDeletedTestTierRows: 3,
  excludeNodeModulesFromGit: 1,
  executeWorktreeRemoval: 1,
  feedbackStatusOnMain: 1,
  fillDerivedBody: 3,
  finishPrivateTriagePublication: 3,
  fleetRatifyGateway: 1,
  gitProbe: 1,
  harvestFollowupsFromReport: 1,
  headIsInWorktree: 1,
  headProvenanceFields: 1,
  holdPrivateTriagePublication: 3,
  hostWorktreeGitAtTopLevel: 1,
  hostWorktreeGitResult: 1,
  irreversibleSignalForWorktree: 1,
  isGitWorktree: 1,
  laneWorkKeepReason: 1,
  lastCommitSubject: 1,
  leafPlanCommitGit: 1,
  listBaseTests: 1,
  main: 1,
  mainOwnedPaths: 2,
  materializeReviewerSnapshot: 4,
  missingCommitLinePrompt: 2,
  newMonolithIdsAgainstBase: 2,
  observeComputedPlacement: 1,
  planPrPreflightAtCommit: 2,
  planRepairGitRun: 1,
  prHeadTreeGit: 1,
  prepareEvidenceRecordContext: 1,
  preserveAndClearUntrackedFixOwner: 1,
  preserveFixHead: 1,
  preserveOrDiscardFixOwnerResidue: 1,
  preserveStagedFixOwnerResidue: 1,
  preserveStaleDirtyFixOwner: 1,
  productionIssueRevalidationPorts: 1,
  proofRepairRoundRefusalInWorktree: 1,
  pruneStaleRuns: 1,
  readAffectedSuitesInput: 1,
  readBaselineRatchetWorktreeState: 3,
  readFixRoundCommitsViaGit: 1,
  readMergedTasks: 1,
  readOwnerHasTrackedWork: 1,
  readPreservedOwnerPatch: 1,
  readRegistrationChanges: 1,
  readWorktreeHeadReflog: 1,
  realReviewWorktree: 1,
  removeAbandonedFixWorktreeOwner: 1,
  removeBaseProofWorktree: 1,
  repairCensusRefusedPush: 3,
  resetTrackedDirtyFixOwner: 1,
  runFixRung: 8,
  runPlanScopedConflictRound: 1,
  runPlanScopedFixRound: 1,
  runTaskBody: 13,
  runnerConfigDigest: 1,
  scopeWorkGit: 1,
  scoutSourceTexts: 1,
  stampRunWorktreeAssignment: 1,
  temporaryIndexTree: 1,
  testTreeId: 1,
  triageCommandLocked: 6,
  unresolvedMainConflicts: 1,
  unwireCredentialHelperSocket: 1,
  watchDispatchSpawn: 1,
  wireCredentialHelperSocket: 1,
  workerCreatedCurrentHead: 1,
  worktreeChangedFiles: 1,
  worktreeDiffStat: 2,
  worktreeGitCapture: 1,
  worktreeGitRunner: 1,
  worktreeHasUncommittedChanges: 1,
  worktreeHeadOrUndefined: 1,
  worktreeMergeBase: 1,
  worktreePushExec: 2,
  worktreeRemove: 1,
  writeFixCensusSnapshot: 1,
};

const BASELINE_FILE = "test/no-daemon-loop-path-calls-the-synchronous-worktree-git-leaf.test.ts";
const LEAF_FILE = "src/lib/worktree-git.ts";

/** A call: the `(` follows the name, so `hostWorktreeGitAsync(` and `hostWorktreeGitAtTopLevel(` do not match. */
const SYNC_GIT_LEAF_CALL = /\bhostWorktreeGit\(/g;

/** The leaf handed over as a VALUE (`readGit = hostWorktreeGit`, `opts.readGit ?? hostWorktreeGit`, `f(root, hostWorktreeGit)`).
 *  `typeof hostWorktreeGit` and a comparison hand nothing over. */
const SYNC_GIT_LEAF_VALUE = /(?:(?<![=!<>])=|\?\?|\|\||[(,:])\s*hostWorktreeGit(?![\w$])(?!\s*\()/g;

function leafUses(fn: Fn): number {
  if (fn.file === LEAF_FILE) return 0;
  return (fn.body.match(SYNC_GIT_LEAF_CALL) ?? []).length + (fn.body.match(SYNC_GIT_LEAF_VALUE) ?? []).length;
}

/** Leaf uses per function NAME (same-named functions in different files sum). */
function population(fns: readonly Fn[]): Map<string, number> {
  const pop = new Map<string, number>();
  for (const f of fns) {
    const n = leafUses(f);
    if (n > 0) pop.set(f.name, (pop.get(f.name) ?? 0) + n);
  }
  return pop;
}

/** Every reached name whose count differs from its row, with both numbers. A row the loop no longer reaches counts 0. */
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
      out.push(`${name} makes ${count} synchronous worktree git call(s) and is reachable from the daemon loop (daemonCommand), but is not in SYNC_GIT_LEAF_LOOP_BASELINE — await hostWorktreeGitAsync instead`);
    } else if (count > row) {
      out.push(`${name} makes ${count} synchronous worktree git call(s) on the daemon loop, above its SYNC_GIT_LEAF_LOOP_BASELINE row of ${row} — await hostWorktreeGitAsync instead`);
    } else if (count < row) {
      out.push(count === 0
        ? `${name} makes 0 synchronous worktree git call(s) on the daemon loop < row ${row} — delete the \`${name}\` row from SYNC_GIT_LEAF_LOOP_BASELINE (${BASELINE_FILE}) in this PR`
        : `${name} makes ${count} synchronous worktree git call(s) on the daemon loop < row ${row} — lower SYNC_GIT_LEAF_LOOP_BASELINE \`${name}\` to ${count} (${BASELINE_FILE}) in this PR`);
    }
  }
  return out;
}

test("W1-T12952 criterion 5: the census lists every loop-reachable caller of the synchronous worktree git leaf, exactly", () => {
  const fns = loopCensusFunctions();
  assert.ok(fns.some((f) => f.name === "daemonCommand"), "the walk must find daemonCommand to seed from");
  const reach = loopReachable(fns, "daemonCommand");
  const pop = population(fns);
  assert.ok([...pop.keys()].filter((n) => reach.has(n)).length > 50, "the scan must see the reached callers across src");
  assert.deepEqual(refusals(fns, SYNC_GIT_LEAF_LOOP_BASELINE), [], "a daemon-loop path calls the synchronous worktree git leaf");

  // The filing-history reader of the lifetime-pressure route awaits the async leaf, so it holds no row.
  for (const name of ["createTaskFilingHistoryInvocation", "resolveTaskFilingHistory"]) {
    assert.ok(reach.has(name), `the loop reaches ${name}`);
    assert.ok(!(name in SYNC_GIT_LEAF_LOOP_BASELINE) && !pop.has(name), `${name} has no row and no synchronous leaf use`);
  }
  // The leaf's own module is not a caller of itself.
  assert.ok(fns.some((f) => f.file === LEAF_FILE && f.name === "hostWorktreeGit"));
  assert.ok(!pop.has("hostWorktreeGit"), "the leaf itself holds no row");
});

test("W1-T12952 criterion 5: a reached function that gains a synchronous leaf call fails with its name", () => {
  const fns = loopCensusFunctions();
  const planted = fns.map((f) =>
    f.name === "resolveTaskFilingHistory" ? { ...f, body: f.body + '\n  hostWorktreeGit(ctx.root, ["status"]);' } : f,
  );
  assert.deepEqual(refusals(planted, SYNC_GIT_LEAF_LOOP_BASELINE), [
    "resolveTaskFilingHistory makes 1 synchronous worktree git call(s) and is reachable from the daemon loop (daemonCommand), but is not in SYNC_GIT_LEAF_LOOP_BASELINE — await hostWorktreeGitAsync instead",
  ]);
  // The seam-default form counts too: the old `options.readGit ?? hostWorktreeGit`.
  const seamed = fns.map((f) =>
    f.name === "createTaskFilingHistoryInvocation" ? { ...f, body: f.body.replace("?? hostWorktreeGitAsync", "?? hostWorktreeGit") } : f,
  );
  assert.deepEqual(refusals(seamed, SYNC_GIT_LEAF_LOOP_BASELINE).map((r) => r.split(" ")[0]), ["createTaskFilingHistoryInvocation"]);
  // A function the loop does not reach may call the leaf (CLI-only).
  const offLoop = [...fns, { name: "someCliOnlyVerb", file: "src/x.ts", body: 'function someCliOnlyVerb() { hostWorktreeGit(r, ["status"]); }' }];
  assert.deepEqual(refusals(offLoop, SYNC_GIT_LEAF_LOOP_BASELINE), []);
});

test("W1-T12952 criterion 5: a count above or below its row fails and names the row", () => {
  const fns = loopCensusFunctions();
  const [name, row] = Object.entries(SYNC_GIT_LEAF_LOOP_BASELINE).find(([, n]) => n >= 2)!;
  const grown = fns.map((f) => (f.name === name ? { ...f, body: f.body + '\n  hostWorktreeGit(root, ["status"]);' } : f));
  assert.deepEqual(refusals(grown, SYNC_GIT_LEAF_LOOP_BASELINE), [
    `${name} makes ${row + 1} synchronous worktree git call(s) on the daemon loop, above its SYNC_GIT_LEAF_LOOP_BASELINE row of ${row} — await hostWorktreeGitAsync instead`,
  ]);
  assert.deepEqual(refusals(fns, { ...SYNC_GIT_LEAF_LOOP_BASELINE, [name]: row + 3 }), [
    `${name} makes ${row} synchronous worktree git call(s) on the daemon loop < row ${row + 3} — lower SYNC_GIT_LEAF_LOOP_BASELINE \`${name}\` to ${row} (${BASELINE_FILE}) in this PR`,
  ]);
  const offLoop = [...fns, { name: "someCliOnlyVerb", file: "src/x.ts", body: 'function someCliOnlyVerb() { hostWorktreeGit(r, ["status"]); }' }];
  assert.deepEqual(refusals(offLoop, { ...SYNC_GIT_LEAF_LOOP_BASELINE, someCliOnlyVerb: 1 }), [
    `someCliOnlyVerb makes 0 synchronous worktree git call(s) on the daemon loop < row 1 — delete the \`someCliOnlyVerb\` row from SYNC_GIT_LEAF_LOOP_BASELINE (${BASELINE_FILE}) in this PR`,
  ]);
});

test("W1-T12952 criterion 5: the count reads calls and handed-over values, never the async leaf or a type", () => {
  for (const used of ['hostWorktreeGit(root, ["status"])', "readGit = hostWorktreeGit,", "(opts.readGit ?? hostWorktreeGit)(a)", "run(root, hostWorktreeGit)", "{ git: hostWorktreeGit }"]) {
    assert.equal(leafUses({ name: "x", file: "src/x.ts", body: `  ${used};` }), 1, used);
  }
  for (const inert of ['hostWorktreeGitAsync(root, ["status"])', 'hostWorktreeGitResult(root, ["status"])', 'hostWorktreeGitAtTopLevel(root, ["x"])',
    "readGit?: typeof hostWorktreeGit", "if (git === hostWorktreeGit) return"]) {
    assert.equal(leafUses({ name: "x", file: "src/x.ts", body: `  ${inert};` }), 0, inert);
  }
  assert.equal(leafUses({ name: "x", file: LEAF_FILE, body: '  hostWorktreeGit(root, ["status"]);' }), 0, "the leaf module is not counted");
});

test("W1-T12952 criterion 5: the baseline records only positive counts for real functions", () => {
  const names = new Set(loopCensusFunctions().map((f) => f.name));
  for (const [name, count] of Object.entries(SYNC_GIT_LEAF_LOOP_BASELINE)) {
    assert.ok(Number.isInteger(count) && count > 0, `${name} must carry a positive count`);
    assert.ok(names.has(name), `${name} no longer exists — delete its baseline row`);
  }
});
