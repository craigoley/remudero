import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// @source-text-subject: declaration ownership, the base reference closure and import direction.
const runTaskSrc = readFileSync(join(REPO_ROOT, "src/run-task.ts"), "utf8");
const sweepSrc = readFileSync(join(REPO_ROOT, "src/cli/commands/sweep.ts"), "utf8");

// Reference census at base 566f9f91f24cd9c0337f82653c134006882e5660.
// Starting with the four roots, retain the reachable declarations with no reference outside the set.
// Exported entrypoint delegates do not count as remaining implementations.
const movedDeclarations = [
  ["FRESH_TREE_STDERR_HOLD_CHARS", "VariableDeclaration"],
  ["spawnRmdReviewForFreshTree", "FunctionDeclaration"],
  ["reviewOptionFlags", "FunctionDeclaration"],
  ["reviewerFreshnessForPublication", "FunctionDeclaration"],
  ["ownStartFreshness", "FunctionDeclaration"],
  ["buildReviewerCodeFreshnessGate", "FunctionDeclaration"],
  ["assigningIssueGateway", "FunctionDeclaration"],
  ["reviewerRevertLane", "FunctionDeclaration"],
  ["buildReviewerHealthRoute", "FunctionDeclaration"],
  ["readyDraftViaGh", "FunctionDeclaration"],
  ["buildRequiredFixReviewRunner", "FunctionDeclaration"],
  ["buildSweepEffects", "FunctionDeclaration"],
  ["codeScanningJudgeDeps", "FunctionDeclaration"],
  ["handedOffHeadRiskJudge", "FunctionDeclaration"],
  ["refreshEscalationTriageEvidence", "FunctionDeclaration"],
  ["changeViewAsync", "FunctionDeclaration"],
  ["untouchedPlanCriterion", "FunctionDeclaration"],
  ["gitStatusResult", "FunctionDeclaration"],
  ["runPlanScopedConflictRound", "FunctionDeclaration"],
  ["runPlanScopedFixRound", "FunctionDeclaration"],
  ["fetchOpenPrsWithPostedIds", "FunctionDeclaration"],
  ["branchAuthorshipStandDownReason", "FunctionDeclaration"],
  ["unchangedTreeStandDownReason", "FunctionDeclaration"],
  ["dispatchFixPreflightStandDown", "FunctionDeclaration"],
  ["withPlanClaims", "FunctionDeclaration"],
  ["gitCredentialFixSpawn", "FunctionDeclaration"],
  ["materializePlanRoundWorktree", "FunctionDeclaration"],
  ["HeadroomRecoveryCandidate", "InterfaceDeclaration"],
  ["buildHeadroomRecoveryCandidates", "FunctionDeclaration"],
  ["renderHeadroomRecoveryCloseComment", "FunctionDeclaration"],
  ["retireRecoveredHeadroomEscalations", "FunctionDeclaration"],
  ["sweepPrTerminalRung", "FunctionDeclaration"],
  ["tickReadReverificationDeps", "FunctionDeclaration"],
  ["updatedForWorkflowFromLedger", "FunctionDeclaration"],
  ["createPlanFilingClassificationTelemetry", "FunctionDeclaration"],
  ["buildOpenPrViews", "FunctionDeclaration"],
  ["buildRereadPrAtAct", "FunctionDeclaration"],
  ["feedbackFixConstraint", "FunctionDeclaration"],
  ["buildFixRungDispatchArgs", "FunctionDeclaration"],
  ["FixRungCheckoutRefusedError", "ClassDeclaration"],
  ["FixHeadRecovery", "InterfaceDeclaration"],
  ["CheckoutFixHeadRefDeps", "InterfaceDeclaration"],
  ["registeredFixWorktreeOwner", "FunctionDeclaration"],
  ["fixHeadHeldByWorktree", "FunctionDeclaration"],
  ["boundedWorktreeOwnerPath", "FunctionDeclaration"],
  ["RegisteredFixOwnerSignal", "TypeAliasDeclaration"],
  ["managedFixOwnerWorktreePrefixes", "VariableDeclaration"],
  ["isManagedFixOwnerWorktreeName", "FunctionDeclaration"],
  ["RegisteredFixOwnerSnapshot", "InterfaceDeclaration"],
  ["RegisteredFixOwnerRecoveryDecision", "TypeAliasDeclaration"],
  ["decideRegisteredFixOwnerRecovery", "FunctionDeclaration"],
  ["ProcessCwdCensusDeps", "InterfaceDeclaration"],
  ["FIX_OWNER_PROC_ENTRY_BOUND", "VariableDeclaration"],
  ["FIX_OWNER_PROC_WALL_MS", "VariableDeclaration"],
  ["pathIsAtOrBelow", "FunctionDeclaration"],
  ["readBoundedProcessCwdCensus", "FunctionDeclaration"],
  ["readRegisteredFixOwnerClaim", "FunctionDeclaration"],
  ["captureRegisteredFixOwnerSnapshot", "FunctionDeclaration"],
  ["readOwnerHasTrackedWork", "FunctionDeclaration"],
  ["removeAbandonedFixWorktreeOwner", "FunctionDeclaration"],
  ["preserveOrDiscardFixOwnerResidue", "FunctionDeclaration"],
  ["preserveStagedFixOwnerResidue", "FunctionDeclaration"],
  ["FIX_OWNER_RESIDUE_PATH_BOUND", "VariableDeclaration"],
  ["FIX_OWNER_OPERATION_MARKERS", "VariableDeclaration"],
  ["readFixOwnerResidue", "FunctionDeclaration"],
  ["resetTrackedDirtyFixOwner", "FunctionDeclaration"],
  ["preserveAndClearUntrackedFixOwner", "FunctionDeclaration"],
  ["preserveStaleDirtyFixOwner", "FunctionDeclaration"],
  ["clearStaleDirtyFixOwner", "FunctionDeclaration"],
  ["preserveFixHead", "FunctionDeclaration"],
  ["preserveAbandonedFixOwnerDivergence", "FunctionDeclaration"],
  ["checkoutFixHeadRef", "FunctionDeclaration"],
  ["createFixRungWorktree", "FunctionDeclaration"],
  ["createFixRungWorktreeWithToolchain", "FunctionDeclaration"],
  ["fixBranchClaimKey", "FunctionDeclaration"],
  ["latestPriorVerdictSuppresses", "FunctionDeclaration"],
  ["repairFilingSuppressionsLogged", "VariableDeclaration"],
  ["captureRepairFeedbackWithPriorVerdict", "FunctionDeclaration"],
  ["runOneShotSweep", "FunctionDeclaration"],
  ["sweepCommand", "FunctionDeclaration"],
  ["buildEscalationCloser", "FunctionDeclaration"],
  ["SweepEscalationReconcileSummary", "InterfaceDeclaration"],
  ["renderEscalationReconcileSummary", "FunctionDeclaration"],
  ["sweepEscalationReconcile", "FunctionDeclaration"],
  ["sweepEscalationTriage", "FunctionDeclaration"],
  ["sweepPostFixReverification", "FunctionDeclaration"],
  ["MOUNT_RECOMMENDER_CADENCE_POLICY", "VariableDeclaration"],
  ["mountRecommenderCadenceMarkerPath", "FunctionDeclaration"],
  ["mountRecommenderNextFireMs", "FunctionDeclaration"],
  ["runMountRecommenderRung", "FunctionDeclaration"],
  ["runAutomaticBranchReapRung", "FunctionDeclaration"],
  ["automaticBranchReapsInFlight", "VariableDeclaration"],
  ["automaticBranchReapSteps", "FunctionDeclaration"],
  ["WORKER_STALLED_LEDGER_STEP", "VariableDeclaration"],
  ["DEFAULT_WORKER_STALL_MS", "VariableDeclaration"],
  ["WorkerStallCandidate", "InterfaceDeclaration"],
  ["findStalledWorkers", "FunctionDeclaration"],
  ["WORKER_STALL_TAIL_ATTACH_MAX_LINES", "VariableDeclaration"],
  ["WORKER_STALL_TAIL_ATTACH_MAX_BYTES", "VariableDeclaration"],
  ["readWorkerTailBestEffort", "FunctionDeclaration"],
  ["runWorkerStallDetectorRung", "FunctionDeclaration"],
  ["buildSweepHook", "FunctionDeclaration"],
  ["lightPassActionable", "FunctionDeclaration"],
  ["blockedFixableIsRequeueOnly", "FunctionDeclaration"],
  ["runIsAwaitingExternal", "FunctionDeclaration"],
  ["fixRungAllowedBesideInFlight", "FunctionDeclaration"],
  ["inFlightTaskIdsFrom", "FunctionDeclaration"],
  ["reviewOnlyLightPassDeps", "FunctionDeclaration"],
  ["LightPassReadPorts", "InterfaceDeclaration"],
  ["createLightPassCompareReader", "FunctionDeclaration"],
  ["buildSweepLightHook", "FunctionDeclaration"],
] as const;

function functionSource(source: string, name: string): string {
  const header = new RegExp('^(?:export )?(?:async )?function\\*? ' + name + '\\(', 'm');
  const match = header.exec(source);
  assert.ok(match, name + " is declared");
  const end = source.indexOf("\n}\n", match.index);
  assert.notEqual(end, -1, name + " closes");
  return source.slice(match.index, end + 2);
}

test("W1-T9338: sweepCommand is defined in its module and src/run-task.ts only delegates to it", () => {
  assert.match(sweepSrc, /^export interface SweepCommandHost \{/m);
  assert.equal(movedDeclarations.length, 111, "the complete base closure is covered");
  const hostStart = sweepSrc.indexOf("export interface SweepCommandHost {");
  const host = sweepSrc.slice(hostStart, sweepSrc.indexOf("\n}\n", hostStart));
  for (const [name, kind] of movedDeclarations) {
    assert.doesNotMatch(host, new RegExp('^  (?:readonly )?' + name + '(?:[?: (])', 'm'),
      name + " is owned by the module rather than injected from the entrypoint");
    if (kind === "FunctionDeclaration") {
      const implementation = functionSource(sweepSrc, name);
      assert.doesNotMatch(implementation, new RegExp('sweepCommandHost\\('), name + " does not bounce to the entrypoint");
      if (name === "createLightPassCompareReader") {
        assert.doesNotMatch(runTaskSrc, new RegExp('^function ' + name + '\\(', 'm'));
        continue;
      }
      const wrapper = functionSource(runTaskSrc, name).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
      const body = wrapper.slice(wrapper.lastIndexOf(" {\n") + 3).trim();
      const root = ["sweepCommand", "buildSweepEffects", "buildSweepHook", "buildSweepLightHook"].includes(name);
      const target = root ? name + "FromModule" : "sweepCommandHelpers";
      assert.match(body, new RegExp('^return (?:yield\\* )?' + target + '\\(sweepCommandHost\\([^;]+;\\s*\\}$'), name + " only delegates");
      assert.equal(body.split("\n").filter(line => line.trim()).length, 2, name + " has no entrypoint logic");
      if (root) assert.match(runTaskSrc, new RegExp(name + ' as ' + name + 'FromModule'));
    } else {
      const declaration = kind === "VariableDeclaration" ? "(?:const|let)"
        : kind === "ClassDeclaration" ? "class" : kind === "InterfaceDeclaration" ? "interface" : "type";
      const header = new RegExp('^(?:export )?' + declaration + ' ' + name + '(?:[ :={])', 'm');
      assert.match(sweepSrc, header, name + " is declared in the module");
      assert.doesNotMatch(runTaskSrc, header, name + " has no entrypoint implementation");
    }
  }
  for (const [name, minimumLines] of [["sweepCommand", 100], ["buildSweepEffects", 300],
    ["buildSweepHook", 250], ["buildSweepLightHook", 150]] as const) {
    assert.ok(functionSource(sweepSrc, name).split("\n").length > minimumLines, name + " holds its real body");
  }
  assert.match(functionSource(sweepSrc, "runOneShotSweep"), /await awaitHandedOffHeadJudgments\(pool\)/);
  assert.match(functionSource(sweepSrc, "updatedForWorkflowFromLedger"), /line\.step !== "sweep\.update_branch\.updated"/);
  assert.ok(runTaskSrc.includes('["sweep", async (rest) => await sweepCommand(rest)]'),
    "the existing handler still calls the entrypoint delegate");
});

test("W1-T9338: the sweep module imports nothing from src/run-task.ts", () => {
  const specifiers = [...sweepSrc.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g)]
    .map(match => match[1]!);
  assert.ok(specifiers.length > 10, "the module's imports were read");
  assert.deepEqual(specifiers.filter(specifier => /(^|\/)run-task(?:\.[jt]s)?$/.test(specifier)), []);
});
