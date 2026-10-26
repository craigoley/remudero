import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// @source-text-subject: this extraction's subject is declaration ownership and import direction.
const runTaskSrc = readFileSync(join(REPO_ROOT, "src/run-task.ts"), "utf8");
const modulePath = join(REPO_ROOT, "src/cli/commands/sweep.ts");
const sweepSrc = existsSync(modulePath) ? readFileSync(modulePath, "utf8") : "";

function topLevelFunction(source: string, header: string): string {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `${header} is declared`);
  const end = source.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `${header} closes`);
  return source.slice(start, end + 2);
}

test("W1-T9338: sweepCommand is defined in its module and src/run-task.ts only delegates to it", () => {
  assert.match(sweepSrc, /^export interface SweepCommandHost \{/m);
  for (const [name, declaration, minimumLines] of [
    ["sweepCommand", "export async function", 100],
    ["buildSweepEffects", "export function", 300],
    ["buildSweepHook", "export function", 250],
    ["buildSweepLightHook", "export function", 150],
  ] as const) {
    const header = `${declaration} ${name}(`;
    const implementation = topLevelFunction(sweepSrc, header);
    assert.ok(implementation.split("\n").length > minimumLines, `${name} holds its real body`);
    const wrapper = topLevelFunction(runTaskSrc, header).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    const bodyStart = wrapper.lastIndexOf(" {\n");
    assert.notEqual(bodyStart, -1, `${name} has a function body`);
    const body = wrapper.slice(bodyStart + 3).trim();
    assert.match(body, new RegExp(`^return ${name}FromModule\\(sweepCommandHost\\([^;]+;\\s*\\}$`));
    assert.equal(body.split("\n").filter((line) => line.trim()).length, 2, `${name} only delegates`);
    assert.match(runTaskSrc, new RegExp(`${name} as ${name}FromModule`));
    assert.equal(runTaskSrc.match(new RegExp(`^${declaration} ${name}\\(`, "gm"))?.length, 1);
  }
  // Reference census at base 566f9f91f24cd9c0337f82653c134006882e5660:
  // 1,313 top-level declarations; retain symbols with references outside the reachable set.
  // Its fixed point contains 111 declarations, including types and module state.
  const helpers = [
    "codeScanningJudgeDeps",
    "handedOffHeadRiskJudge",
    "updatedForWorkflowFromLedger",
    "createPlanFilingClassificationTelemetry",
    "buildOpenPrViews",
    "runOneShotSweep",
    "renderEscalationReconcileSummary",
    "sweepEscalationReconcile",
    "sweepEscalationTriage",
    "sweepPostFixReverification",
    "runAutomaticBranchReapRung",
    "spawnRmdReviewForFreshTree",
    "buildReviewerCodeFreshnessGate",
    "buildReviewerHealthRoute",
    "readyDraftViaGh",
    "buildRequiredFixReviewRunner",
    "runPlanScopedFixRound",
    "dispatchFixPreflightStandDown",
    "materializePlanRoundWorktree",
    "buildFixRungDispatchArgs",
    "registeredFixWorktreeOwner",
    "boundedWorktreeOwnerPath",
    "decideRegisteredFixOwnerRecovery",
    "captureRegisteredFixOwnerSnapshot",
    "removeAbandonedFixWorktreeOwner",
    "preserveOrDiscardFixOwnerResidue",
    "preserveStagedFixOwnerResidue",
    "resetTrackedDirtyFixOwner",
    "preserveAndClearUntrackedFixOwner",
    "preserveStaleDirtyFixOwner",
    "clearStaleDirtyFixOwner",
    "preserveAbandonedFixOwnerDivergence",
    "createFixRungWorktreeWithToolchain",
    "fixBranchClaimKey",
    "captureRepairFeedbackWithPriorVerdict",
    "refreshEscalationTriageEvidence",
    "gitCredentialFixSpawn",
    "sweepPrTerminalRung",
    "tickReadReverificationDeps",
    "buildRereadPrAtAct",
    "runMountRecommenderRung",
    "runWorkerStallDetectorRung",
    "lightPassActionable",
    "blockedFixableIsRequeueOnly",
    "fixRungAllowedBesideInFlight",
    "inFlightTaskIdsFrom",
    "reviewOnlyLightPassDeps",
    "changeViewAsync",
    "fetchOpenPrsWithPostedIds",
    "retireRecoveredHeadroomEscalations",
    "buildEscalationCloser",
    "automaticBranchReapSteps",
    "reviewOptionFlags",
    "assigningIssueGateway",
    "reviewerRevertLane",
    "reviewerFreshnessForPublication",
    "ownStartFreshness",
    "untouchedPlanCriterion",
    "runPlanScopedConflictRound",
    "feedbackFixConstraint",
    "unchangedTreeStandDownReason",
    "withPlanClaims",
    "isManagedFixOwnerWorktreeName",
    "pathIsAtOrBelow",
    "readBoundedProcessCwdCensus",
    "readRegisteredFixOwnerClaim",
    "readOwnerHasTrackedWork",
    "readFixOwnerResidue",
    "preserveFixHead",
    "createFixRungWorktree",
    "latestPriorVerdictSuppresses",
    "mountRecommenderCadenceMarkerPath",
    "mountRecommenderNextFireMs",
    "findStalledWorkers",
    "readWorkerTailBestEffort",
    "runIsAwaitingExternal",
    "buildHeadroomRecoveryCandidates",
    "renderHeadroomRecoveryCloseComment",
    "gitStatusResult",
    "branchAuthorshipStandDownReason",
    "checkoutFixHeadRef",
    "fixHeadHeldByWorktree"
  ];
  const hostStart = sweepSrc.indexOf("export interface SweepCommandHost");
  const hostInterface = sweepSrc.slice(hostStart, sweepSrc.indexOf("\n}\n", hostStart));
  for (const name of helpers) {
    assert.match(sweepSrc, new RegExp(`^(?:async )?function\\*? ${name}\\(`, "m"),
      `${name} has its implementation in the module`);
    assert.doesNotMatch(hostInterface, new RegExp(`^  (?:readonly )?${name}[(:?]`, "m"),
      `${name} belongs to the closure, not the host`);
  }
  for (const name of [
    "FixRungCheckoutRefusedError",
    "DEFAULT_WORKER_STALL_MS",
    "SweepEscalationReconcileSummary",
    "automaticBranchReapsInFlight",
    "FRESH_TREE_STDERR_HOLD_CHARS",
    "RegisteredFixOwnerSnapshot",
    "RegisteredFixOwnerRecoveryDecision",
    "FixHeadRecovery",
    "repairFilingSuppressionsLogged",
    "MOUNT_RECOMMENDER_CADENCE_POLICY",
    "WORKER_STALLED_LEDGER_STEP",
    "WORKER_STALL_TAIL_ATTACH_MAX_LINES",
    "WORKER_STALL_TAIL_ATTACH_MAX_BYTES",
    "RegisteredFixOwnerSignal",
    "managedFixOwnerWorktreePrefixes",
    "ProcessCwdCensusDeps",
    "FIX_OWNER_PROC_ENTRY_BOUND",
    "FIX_OWNER_PROC_WALL_MS",
    "FIX_OWNER_OPERATION_MARKERS",
    "FIX_OWNER_RESIDUE_PATH_BOUND",
    "CheckoutFixHeadRefDeps",
    "WorkerStallCandidate",
    "HeadroomRecoveryCandidate"
  ]) {
    assert.match(sweepSrc, new RegExp(`^(?:export )?(?:const|class|interface|type) ${name}\\b`, "m"));
    assert.doesNotMatch(runTaskSrc, new RegExp(`^(?:export )?(?:const|class|interface|type) ${name}\\b`, "m"));
  }
  for (const name of [
    "codeScanningJudgeDeps",
    "handedOffHeadRiskJudge",
    "updatedForWorkflowFromLedger",
    "createPlanFilingClassificationTelemetry",
    "buildOpenPrViews",
    "runOneShotSweep",
    "renderEscalationReconcileSummary",
    "sweepEscalationReconcile",
    "sweepEscalationTriage",
    "sweepPostFixReverification",
    "runAutomaticBranchReapRung",
    "spawnRmdReviewForFreshTree",
    "buildReviewerCodeFreshnessGate",
    "buildReviewerHealthRoute",
    "readyDraftViaGh",
    "buildRequiredFixReviewRunner",
    "runPlanScopedFixRound",
    "dispatchFixPreflightStandDown",
    "materializePlanRoundWorktree",
    "buildFixRungDispatchArgs",
    "registeredFixWorktreeOwner",
    "decideRegisteredFixOwnerRecovery",
    "captureRegisteredFixOwnerSnapshot",
    "removeAbandonedFixWorktreeOwner",
    "preserveOrDiscardFixOwnerResidue",
    "preserveStagedFixOwnerResidue",
    "resetTrackedDirtyFixOwner",
    "preserveAndClearUntrackedFixOwner",
    "preserveStaleDirtyFixOwner",
    "clearStaleDirtyFixOwner",
    "preserveAbandonedFixOwnerDivergence",
    "createFixRungWorktreeWithToolchain",
    "fixBranchClaimKey",
    "captureRepairFeedbackWithPriorVerdict",
    "refreshEscalationTriageEvidence",
    "gitCredentialFixSpawn",
    "sweepPrTerminalRung",
    "tickReadReverificationDeps",
    "buildRereadPrAtAct",
    "runMountRecommenderRung",
    "runWorkerStallDetectorRung",
    "lightPassActionable",
    "blockedFixableIsRequeueOnly",
    "fixRungAllowedBesideInFlight",
    "inFlightTaskIdsFrom",
    "reviewOnlyLightPassDeps",
    "changeViewAsync",
    "fetchOpenPrsWithPostedIds",
    "retireRecoveredHeadroomEscalations",
    "buildEscalationCloser",
    "reviewOptionFlags",
    "assigningIssueGateway",
    "reviewerRevertLane",
    "reviewerFreshnessForPublication",
    "ownStartFreshness",
    "feedbackFixConstraint",
    "unchangedTreeStandDownReason",
    "withPlanClaims",
    "readBoundedProcessCwdCensus",
    "readRegisteredFixOwnerClaim",
    "createFixRungWorktree",
    "latestPriorVerdictSuppresses",
    "findStalledWorkers",
    "runIsAwaitingExternal",
    "buildHeadroomRecoveryCandidates",
    "renderHeadroomRecoveryCloseComment",
    "branchAuthorshipStandDownReason",
    "checkoutFixHeadRef"
  ]) {
    const header = new RegExp(`^export (?:async )?function ${name}\\(`, "m").exec(runTaskSrc)?.[0];
    assert.ok(header, `${name} keeps its exported signature`);
    const wrapper = topLevelFunction(runTaskSrc, header);
    const body = wrapper.slice(wrapper.lastIndexOf(" {\n") + 3).trim();
    assert.match(body, new RegExp(`^return sweepCommandHelpers\\(sweepCommandHost\\(\\)\\)\\.${name}\\([^;]*;\\s*\\}$`),
      `${name} only delegates to the module`);
  }

});

test("W1-T9338: the sweep module imports nothing from src/run-task.ts", () => {
  const specifiers = [...sweepSrc.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g)]
    .map((match) => match[1]!);
  assert.ok(specifiers.length > 10, "the module's imports were read");
  assert.deepEqual(specifiers.filter((specifier) => /(^|\/)run-task(?:\.[jt]s)?$/.test(specifier)), []);
});
