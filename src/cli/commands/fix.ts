/** The fix verb and its exclusive helpers, moved from the entrypoint (W1-T9337). */
import type { RunTaskCommandHost, GitRunner, CiGateOutcome, ReviewRunResult, FixRungOutcome, LiveHeadResult, WorktreeSnapshot, FixRebaseMergeFacts, FixRoundCommit, CensusPushRefusal, FixRoundPushReceipt } from "./run-task-verb.js";
import { buildBaseProofDir, releaseBaseProofDir, type BaseProofDir } from "../../lib/check-proof.js";
import { judgeFixProgress, resolveFixProgress, type FixProgressJudge, type FixProgressVerdict, reviewerProofFailures } from "../../lib/fix-progress-judge.js";
import { BASE_REPRODUCTION_MAX_FILES, boundedBaseProbeReason, baseReproductionFiles, decideBaseReproduction, type BaseProbeResult } from "../../lib/base-reproduction.js";
import { assessRefreshClearance, mainPathsReachingRed, REFRESH_CLEARANCE_STEP, refreshClearanceFields, refreshedOnSameRed, refreshRecordsFromLedger } from "../../lib/base-reproduction.js";
import { anchoredFixOutcome, decideFixOutcomeAction, fixRoundFlakeRetryRows, readRedAttribution, scopeReroutedFields, type FixOutcome as TypedFixOutcome } from "../../lib/fix-outcome.js";
import { fixRoundBaseHead } from "../../lib/fix-round-base.js";
import { admittedFixTestPaths } from "../../lib/fix-test-scope.js";
import { productionFixProgressJudge, CHECK_REQUEUE_DEFERRED_STEP, CHECK_REQUEUE_STEP, jobRequeueOutcome, requeuedCheckKeysFromLedger, type JobRequeueOutcome } from "../../lib/sweep.js";
import { ghExec, ghJsonAsync } from "../../lib/github-transport.js";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { loadConfig, type Config } from "../../lib/config.js";
import { ledgerPathFor } from "../../lib/ledger-path.js";
import { isPrMergedNow, mergeTargetFromPrUrl } from "../../lib/arm-auto-merge.js";
import { ciFailureLedgerEntry } from "../../lib/ci-friction-gardener.js";
import { conflictedFilePaths } from "../../lib/hot-file-gardener.js";
import { billingMode } from "../../lib/env.js";
import { FIX_MODE_RULES, deriveFixMode, fixScopeRegime, outOfDeclaredScopeFiles, renderFixPrompt, renderPrerequisitePrPrompt, type FixEvidence, type FixReviewFinding } from "../../lib/prompt-render.js";
import { bakedClosureCatalogDetails } from "../../lib/baked-closure-catalog.js";
import { escalateWithJudge, escalationCause, realEscalationJudge, escalationHeadSha, escalationContractRevision, findDuplicateEscalation, taskContractRevision, taskSemanticRevision, type EscalationDedupKey, type IssueGateway, type OpenIssue } from "../../lib/escalate.js";
import { fetchSinglePrRest, codeqlCheckFailed, hydrateCodeqlHeadAlertsSteps, CODEQL_CHECK_NAME, type GhApiFetcher } from "../../lib/open-prs-rest.js";
import { remedyFilesForFailingChecks, type RemedyFileForGate } from "../../lib/ci-parity.js";
import { isInPlanScope } from "../../lib/plan-architect.js";
import { createPlanPrRest, probeExistingPlanPr } from "../../lib/plan-pr-emitter.js";
import { findTaskShard, parseProofAmendmentProposal, requestProofAmendment, requestScopeAmendment, isUngrantableInstrumentPath, saveScopeAmendmentWork, restoreScopeAmendmentWork, type ScopeAmendmentOutcome, type ProofAmendmentOutcome } from "../../lib/proof-amendment.js";
import { appendLedger, isSpawnInfraBlockedError, LEDGER_COST_TAG_INFRA } from "../../lib/ledger.js";
import { systemClock } from "../../lib/clock.js";
import { observeFeedbackInputs, type AdmissionObserver } from "../../lib/contributor-admission.js";
import { observeContributorAdmission } from "../../lib/arm-auto-merge.js";
import { observeAdmissionDisposition } from "../../lib/action-executor.js";
import { fixLaneBenchmarkWork } from "../../lib/benchmark-run.js";
import { captureCiRemedyComponent, recordCiRemedyExecution } from "../../lib/ci-remedy-execution.js";
import { loadPlan, visibleCriteria, type AcceptanceCriterion, type Plan } from "../../lib/plan.js";
import { loadMounts, mountsPath, type Mount } from "../../lib/mounts.js";
import { fixArmEvidence, fixRoutingWeights, readFixRoutingRows, type FixLearnedArms } from "../../lib/fix-routing-learner.js";
import { loadInjectableSkills, observeSkillSelection, renderSkillsPart, SKILL_FIX_TASK_TYPE, skillWithheldForRun } from "../../lib/skill-workshop.js";
import { DEFAULT_KNOWLEDGE_BUDGET_CHARS } from "../../lib/learnings.js";
import { recognizeChangesetClaims, acceptanceAuthorTimeCheck, extractTaskTrailerId, parseAcceptanceBlock, reviewLedgerKeyFor, UNFILED_RUN_SENTINEL, reviewInputDigest, reviewLedgerReasons, resolvePlanCriteriaAtHeadAsync, type PlanCriteriaAtHeadResult, type CriterionVerdict } from "../../lib/review.js";
import { repairedProofsAreSafeToPush, diagnoseUnrunnableProofs, renderBodyDefects } from "../../lib/body-repair.js";
import { recordHeadProviderAfterPush } from "../../lib/review-provider-provenance.js";
import { ghRequiredStatusCheckContexts, readLedgerLines, taskIdFromRunBranch } from "../../lib/status.js";
import { withCodeqlAlertEvidence, CODE_SCANNING_FALSE_POSITIVE_STEP, DEFAULT_SWEEP_POLICY, decideRedBaseRefresh, isCiHarnessPath, actionableGateFailuresFromReasons, dispatchFixSpent, checksStateFromRollup, checksPendingSinceFromRollup, deriveDisposition, fixRoundTally, buildFixProgressInput, flakeClaimsForHead, isBlockedCi, renderClarificationQuestion, redQualityGateNames, stillRedRequiredNames, terminalStateReason, type ActionableGateFailure, type CiFailure, type LiveStateResult, type OpenPrView, type RollupCheckEntry, type ProofDiscriminationEvidence, type SweepDeps, type SweepPolicy, proofDiscriminationEvidenceFromCriteria, ADDITIVE_REGISTRATION_SURFACES, type RegistrationChange, hasCapturedMergeConflictEvidence, clearedConflictEscalationCause } from "../../lib/sweep.js";
import { forcedRefreshFields, REFRESH_DECIDED_STEP } from "../../lib/refresh-value.js";
import { detectReviewFalseBlock, detectCiLogVerdictUnchanged, shouldSelfHealNothingChanged } from "../../lib/fix-rung-classify.js";
import { readCiGateRequiredChecks } from "../../lib/ci-gate-required.js";
import { dropDerivativeAggregateCiFailure } from "../../lib/derivative-ci-failure.js";
import { ghJson, parseReport, foreignTreeStandDownReason, workerTranscript, worktreeAdd, worktreeRemove, type SpawnWorkerArgs, type ForeignTreeStandDown, type RegisteredWorktree, type WorkerResult, workerContinuation } from "../../lib/worker.js";
import { hostWorktreeGit, hostWorktreeGitAsync } from "../../lib/worktree-git.js";
import { runStepsAsync, runStepsSync, step } from "../../lib/git-push.js";
import { FIX_WORKER_TOOLS, FIX_WORKER_TOOLS_HARNESS_COMMITS } from "../../lib/fix-fence.js";
import { assertLiveWriteAllowed } from "../../lib/live-write-guard.js";
import { repoRoot, resolveOwnerRepo } from "../../lib/repo-location.js";
import { refusalExcerptFromFixReport } from "../../lib/refusal-amendment.js";
import { flagValue, unknownArgError } from "../../lib/cli-args.js";
import { reviewTaskIdFromBody } from "../../lib/report-commands.js";
import { type RawOpenPr, type StrikeRegime, currentStrikeRegimeFor, deriveStrikeHistory, fetchCiFailures, priorStrikesFor, remedyGeneratorNamedInLog, reviewStateFromRollup, reviewSummaryFromLedger, reviewVerdictPostedAtFromRollup, unmetFromLedger } from "../../lib/tick-read-worker.js";

// Functions kept in the entrypoint arrive through this seam, as in DaemonCommandHost.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HostFn = (...args: any[]) => any;
export interface FixCommandHost {
  readonly ACCEPTANCE_GATE_BODY_REPAIR_FALLBACK: AcceptanceCriterion[];
  readonly CENSUS_PUSH_CHECK: RunTaskCommandHost["CENSUS_PUSH_CHECK"];
  readonly CENSUS_PUSH_NEVER_BYPASS: RunTaskCommandHost["CENSUS_PUSH_NEVER_BYPASS"];
  readonly CENSUS_SNAPSHOT_ENV: RunTaskCommandHost["CENSUS_SNAPSHOT_ENV"];
  readonly FIX_RUNG_GATE_REMEDY_SCOPE_DEADLOCK_DISPOSITION: "gate_remedy_scope_deadlock";
  readonly FixRoundPushError: RunTaskCommandHost["FixRoundPushError"];
  readonly GIT_UNTRACKED_FILES_ALL: string;
  readonly MERGE_HEAD_ABSENT_REASON: string;
  readonly MERGE_UP_TO_DATE_REASON: string;
  readonly MISSING_COMMIT_MESSAGE_REASON: RunTaskCommandHost["MISSING_COMMIT_MESSAGE_REASON"];
  readonly PLAN_SCOPE_PATHS: string;
  readonly USAGE: string;
  readonly acceptanceGateBodyRepair: HostFn;
  readonly addedTestCriterion: HostFn;
  readonly addedTestFilesAtHead: HostFn;
  readonly archiveWorkerTranscript: RunTaskCommandHost["archiveWorkerTranscript"];
  readonly buildBaseReproductionProbe: RunTaskCommandHost["buildBaseReproductionProbe"];
  readonly buildImportClosureRead: HostFn;
  readonly buildProofAmendmentGitOps: RunTaskCommandHost["buildProofAmendmentGitOps"];
  readonly buildProofAmendmentWritePorts: RunTaskCommandHost["buildProofAmendmentWritePorts"];
  readonly buildSweepEffects: HostFn;
  readonly checkFixCensusSnapshotAsync: RunTaskCommandHost["checkFixCensusSnapshotAsync"];
  readonly ciEvidenceDisagreementObservation: HostFn;
  readonly ciGateState: RunTaskCommandHost["ciGateState"];
  readonly commandSyntax: HostFn;
  readonly commitsAhead: RunTaskCommandHost["commitsAhead"];
  readonly diffAnchoredFallback: HostFn;
  readonly diffSinceMergeBase: HostFn;
  readonly fetchPrBodyViaGh: RunTaskCommandHost["fetchPrBodyViaGh"];
  readonly fetchPrDiffFilesViaGh: RunTaskCommandHost["fetchPrDiffFilesViaGh"];
  readonly fixCensusAppliesToRepo: RunTaskCommandHost["fixCensusAppliesToRepo"];
  readonly fixRoundGitOwnership: RunTaskCommandHost["fixRoundGitOwnership"];
  readonly fixWorkerReceipt: RunTaskCommandHost["fixWorkerReceipt"];
  readonly fixWorkerRunId: RunTaskCommandHost["fixWorkerRunId"];
  readonly harnessCommitForShellLessWorker: RunTaskCommandHost["harnessCommitForShellLessWorker"];
  readonly harvestFollowupsFromReport: RunTaskCommandHost["harvestFollowupsFromReport"];
  readonly hostWorktreeGitResult: RunTaskCommandHost["hostWorktreeGitResult"];
  readonly mainTipViaGit: HostFn;
  readonly missingCommitLinePrompt: RunTaskCommandHost["missingCommitLinePrompt"];
  readonly prNumberFromRef: RunTaskCommandHost["prNumberFromRef"];
  readonly prUrlTarget: RunTaskCommandHost["prUrlTarget"];
  readonly proofRepairRoundRefusalInWorktree: RunTaskCommandHost["proofRepairRoundRefusalInWorktree"];
  readonly readHeadShaRest: RunTaskCommandHost["readHeadShaRest"];
  readonly readRegistrationChanges: RunTaskCommandHost["readRegistrationChanges"];
  readonly readWorktreeHeadReflog: RunTaskCommandHost["readWorktreeHeadReflog"];
  readonly requeueActionsJobSteps: HostFn;
  readonly spawnFixWorkerBounded: RunTaskCommandHost["spawnFixWorkerBounded"];
  readonly startShellLessMergeConflictMerge: RunTaskCommandHost["startShellLessMergeConflictMerge"];
  readonly updatePrBodyViaGh: HostFn;
  readonly withPredecessorTranscriptCopies: RunTaskCommandHost["withPredecessorTranscriptCopies"];
  readonly workerBoundaryStack: RunTaskCommandHost["workerBoundaryStack"];
  readonly workerChangedPaths: (raw: string) => string[];
  readonly workerCreatedCurrentHead: RunTaskCommandHost["workerCreatedCurrentHead"];
  readonly worktreeHasUncommittedChanges: RunTaskCommandHost["worktreeHasUncommittedChanges"];
}

/**
 * W1-T2272: the check-run name `.github/workflows/acceptance-author-gate.yml` reports under
 * (its job's own `name:` field — the SAME string GitHub's status-check rollup, and therefore
 * `CiFailure.name`, carries). `runFixRung`'s pre-strike body-repair site matches on this
 * EXACTLY — never "any ci-log round" — so a PR failing for an unrelated reason (a real test
 * failure, a lint error) is never short-circuited into a body edit that does nothing for the
 * check that is actually red.
 */
const ACCEPTANCE_AUTHOR_GATE_CHECK_NAME = "acceptance-author-gate";

export interface FixRungGateRemedyScopeDeadlock {
  disposition: FixCommandHost["FIX_RUNG_GATE_REMEDY_SCOPE_DEADLOCK_DISPOSITION"];
  gate: string;
  file: string;
  declaringEntry: string;
  declaringEntryExists: boolean;
  source: "registry" | "ci-output";
}

export type ReachableRemedyFileInput = string | RemedyFileForGate;

/** One generator-fix attempt's outcome — see {@link runGeneratorFixForCiFailures}'s own doc. */
export interface GeneratorFixResult {
  /** `true` iff every generator ran, its own `:check` re-ran green, and (if anything changed) a commit landed. */
  applied: boolean;
  /** The generator script name(s) actually run, de-duplicated, first-seen order. */
  generators: string[];
  /** The commit this attempt produced, when one did — absent when nothing changed (already fresh) or `applied` is false. */
  commitSha?: string;
  /**
   * Set ONLY when a generator ran clean but its OWN `--check` still failed afterward — a REAL
   * failure (rationale (4)): this attempt never commits in that case, and the caller is expected
   * to fall through to the ordinary fix rung rather than retry this same short-circuit forever.
   */
  escalate?: { generator: string; detail: string };
}

/**
 * W1-T138 (the #303/#305/#292/#315 fix), reworked by W1-T1279 (the #2624 fix): render ONE
 * ci-log failure as a single, specific line — the check NAME plus its DIAGNOSTIC line, e.g.
 * `CodeQL — js/incomplete-url-substring-sanitization @ test/worker.test.ts:318 — Incomplete URL
 * substring sanitization`. An escalation that names only the bare check ("CodeQL") leaves the
 * operator to go re-fetch the log by hand; this line is what a `gh run view --log-failed` tail
 * (or an injected test fixture) already carries, verbatim, never re-derived or guessed.
 *
 * W1-T1279's OWN FIX. `f.logTail` is a `gh run view --log-failed` extract: lines shaped
 * `<job>\t<step>\t<timestamp> <content>`, and the FIRST such line is, BY CONSTRUCTION, the
 * failing step's own `##[group]Run <cmd>` invocation banner for every `run:` step GitHub
 * Actions executes — `.find((l) => l.length > 0)` (the old selection) therefore returned the
 * COMMAND that ran, never the failure it produced (issues/2624's "Failing check(s):" section,
 * verbatim). This selects the first line, after stripping that prefix, that LOOKS LIKE A
 * COMPILER/TEST-RUNNER DIAGNOSTIC instead — skipping `##[group]`/`##[endgroup]`/`---`-banner/
 * bare-timestamp lines along the way. WHEN NOTHING MATCHES that shape, this falls back to
 * exactly the OLD selection (today's first non-empty line) rather than to nothing — a banner is
 * a poor summary but an empty one is worse, and the W1-T487 empty-evidence wording
 * (`renderEscalationEvidence`, below) must keep meaning "there was truly nothing", never
 * "nothing looked like a diagnostic".
 */
export const CI_LOG_LINE_PREFIX_RE = /^[^\t\n]*\t[^\t\n]*\t\S+ ?/;

export const CI_LOG_BANNER_RE = /^(##\[(group|endgroup)\]|-{3,})/;

export const CI_LOG_BARE_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$/;

export const CI_LOG_DIAGNOSTIC_RE = new RegExp(
  [
    "error TS\\d+:", // tsc
    "\\(\\d+,\\d+\\):\\s*(error|warning)", // tsc-shaped `file(line,col): error|warning`
    ":\\d+:\\d+:?\\s*(error|Error|warning)", // eslint/compiler `file:line:col: error`
    "^(Error|TypeError|ReferenceError|AssertionError|SyntaxError|RangeError):", // thrown JS errors
    "^\\s*(✕|✗|FAIL)\\b", // jest/mocha failing-test markers
    "Expected:|Received:", // jest assertion diff
  ].join("|"),
);

/**
 * W1-T1095 (capability 3 — REBASE): the observed facts the rebase decision reads. Split from
 * its I/O so every arm below is a unit fixture — the same split `fixRungTerminationVerdict`
 * (above) already took when the coverage gate forced it.
 */
export interface FixRebaseFacts {
  /** The prerequisite `outOfDiffBlockerFor` named, which `prerequisiteMerged` has just read
   *  as MERGED. Present on every call — this decision is only ever reached on the resume path. */
  prerequisitePr: number;
  /** Did the review this rung is acting on already PASS? A new head DISCARDS a posted verdict
   *  and spends one of two review-orphan slots (W1-T225/W1-T1018), so a passing review is the
   *  one state where rebasing costs more than it can possibly buy. */
  reviewPassed: boolean;
  /** GitHub's own `mergeable` reading. `"CONFLICTING"` is the SWEEP's path, never this rung's —
   *  it already resolves non-deletion conflicts and correctly refuses deletion ones. Anything
   *  other than a definite `"MERGEABLE"` refuses (fail-safe, the same direction every other
   *  read in this file takes on state it cannot resolve). */
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN" | undefined;
  /** `compare(base...head).behind_by` — how many commits the base carries that this head does
   *  not. `undefined` when the comparison could not be read. */
  behindBy: number | undefined;
  /** Has a `fix.rebased` row already been written for this pull request? The shard's design (iii)
   *  bounds this at AT MOST ONE rebase-and-retry per blocked pull request. */
  alreadyRebased: boolean;
}

/** {@link decideFixRebase}'s verdict — `reason` is written to the ledger on BOTH arms, so a
 *  refusal is never silent (design note ii: every termination writes a row naming its reason). */
export interface FixRebaseDecision {
  rebase: boolean;
  reason: string;
}

/**
 * BACKSTOP (W1-T1266's declared-kind convention): under HEALTHY operation this never fires — a
 * genuine fix resolves the review and the loop exits via `review.state === "success"` long before
 * any cap is reached. This bound only bites once the ordinary path has ALREADY failed to happen
 * across multiple rounds (a check stays red no matter how many retrigger-shaped rounds run), the
 * same "fires only once something else has already failed" shape CLAUDE.md names.
 *
 * The per-head bound on retrigger-shaped rounds ONE `runFixRung` invocation spends before it
 * stops retriggering and escalates naming the check(s) that stayed red — see the exhaustion
 * branch near this function's own `retriggerCap` read. A SEPARATE, SMALL cap, never
 * `fixStrikeCap` (config.ts) — that value is unchanged by this task in either direction — and
 * never a timer: a permanently failing check stops after this many retriggers on the SAME rung
 * dispatch, not after an elapsed duration.
 */
export const DEFAULT_FIX_RETRIGGER_CAP = 2;

/**
 * W1-T5544 — THE PROOF-REPAIR FIX MODE. A fleet PR red ONLY on `proof-discrimination` (a trailered PR whose named plan
 * proofs pass at both head and merge base) was escalated as "scope or proof amendment is required", 32 times in a week,
 * though the operator's two hand repairs (#8866, #8861) were both TEST-FILE edits inside the PR's own scope: make a test
 * assert the state the PR newly records, or rename a test so its title carries the claim. This mode lets the fix lane make
 * that edit — and ONLY that edit.
 *
 * The mode is declared HERE and composed ahead of {@link FIX_MODE_RULES}, never edited into it: the table's own
 * `proof-discrimination` row (a capped GREEN review) keeps its meaning, and `source: "gate-log"` — evidence read from the
 * red check's own job log at this head, with no posted review behind it — is what selects this one.
 */
export const PROOF_REPAIR_FIX_MODE = "proof-repair";

export const PROOF_REPAIR_FIX_MODE_RULES: typeof FIX_MODE_RULES = [
  { mode: PROOF_REPAIR_FIX_MODE, when: (e) => e.proofDiscrimination?.source === "gate-log" && e.proofDiscrimination.proofs.length > 0 },
  ...FIX_MODE_RULES,
];

const PROOF_REPAIR_TEST_PATH = /^test\//;

// W1-T9618: a real push names the head it sent to origin
const isFixRoundPushReceipt = (value: unknown): value is FixRoundPushReceipt =>
  typeof value === "object" && value !== null && "fixRoundPushedHead" in value;

export type FixRoundLanding = { landed: true; remoteHead?: string } // W1-T9618: did the round's commit reach the remote branch?
  | { landed: false; outcome: "failed" | "refused" | "not_on_remote" | "remote_unreadable"; cause?: string; reason: string; remoteHead?: string };

/** W1-T4207: at most this many undeclared paths ride a `fix.commit_refused` row; the rest are counted. */
const COMMIT_REFUSED_PATH_CAP = 20;

/** What `routeFix` did with one PR — mirrors the sweep's per-PR action shape. */
export type FixOutcome = "fixed" | "escalated" | "refused";

/** The two gated effects `routeFix` may fire — the SAME shape `SweepDeps` wires. */
export interface FixDeps {
  dispatchFix: SweepDeps["dispatchFix"];
  escalate: SweepDeps["escalate"];
  /** W1-T7096: decides whether a PR that already spent rounds gets another; unwired ⇒ the announced stand-in. */
  fixProgressJudge?: FixProgressJudge;
  /** The ledger the judge reads the round history from. */
  ledgerLines?: () => ReadonlyArray<Record<string, unknown>>;
  log?: (step: string, extra?: Record<string, unknown>) => void;
}

const helpersByHost = new WeakMap<FixCommandHost, ReturnType<typeof buildFixCommandHelpers>>();

export function fixCommandHelpers(host: FixCommandHost) {
  let helpers = helpersByHost.get(host);
  if (!helpers) {
    helpers = buildFixCommandHelpers(host);
    helpersByHost.set(host, helpers);
  }
  return helpers;
}

function buildFixCommandHelpers(host: FixCommandHost) {
const ciRemedyComponent = captureCiRemedyComponent(host.workerBoundaryStack.loadedModule, ciLogNamedSourcePaths, existsSync, join);

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

function deriveChangesetClaimUpdate(body: string, diffFiles: string[]): string | undefined {
  if (diffFiles.length === 0) return undefined;
  // A drifted count stopped being a REFUSAL (lib/review.ts) but did not stop being worth tidying,
  // and those are different decisions. `staleCountClaims` carries exactly the claims the count arm
  // used to refuse; reading both keeps this rung's behaviour identical to before that change.
  const recognition = recognizeChangesetClaims(body, diffFiles);
  const repairable = [...recognition.contradictions, ...recognition.staleCountClaims];
  const countClaims = repairable.filter((c) => /^exactly\s+\w+\s+files?\b/i.test(c.claim));
  if (countClaims.length !== 1) return undefined; // none, or ambiguous — fail safe

  const claim = countClaims[0].claim;
  const firstIdx = body.indexOf(claim);
  // The claim must appear, and appear EXACTLY ONCE — a repeat means the splice below could land
  // on the wrong occurrence (or both), which is exactly the "wrong edit" design point 4 forbids.
  if (firstIdx === -1 || body.indexOf(claim, firstIdx + 1) !== -1) return undefined;

  // REFUSE WHEN THE ENUMERATION CONTINUES PAST THE CLAIM THE DETECTOR HANDED US.
  //
  // `recognizeChangesetClaims`' own `countRe` (lib/review.ts) captures an enumeration as
  // `[^\s,]+(?:\s*,\s*[^\s,]+)*` — COMMA-SEPARATED ONLY. An author who writes the last item with
  // "and" therefore gets a claim that STOPS EARLY: MEASURED, `exactly two files: src/x.ts and
  // src/y.ts` recognises as the claim `exactly two files: src/x.ts`, leaving ` and src/y.ts`
  // outside it. The splice below replaces only the recognised span, so the orphan survives and the
  // repaired body reads `exactly 3 files: a.ts, b.ts, c.ts and src/y.ts` — a body that now names
  // FOUR paths while claiming three, which is a WORSE claim than the stale one it replaced.
  //
  // THIS IS AN EDIT, NOT A MISS, WHICH IS WHY IT MATTERS: every other refusal in this function
  // guards against changing the wrong text, and this one guards against changing the right text
  // INCOMPLETELY. A false-positive auto-edit is strictly worse than leaving the claim stale for a
  // human, because the stale claim is at least self-consistent.
  //
  // The guard is deliberately NARROW: it fires only when the text immediately after the claim
  // continues the list with a PATH-SHAPED token (one containing `.` or `/` — the same shape test
  // this file's own changeset checks use to stay silent on prose). `exactly 3 files. And the
  // rationale...` does not match (the period ends the clause), and `exactly 3 files and 2
  // directories` does not match (`2` and `directories` are not path-shaped), so ordinary prose is
  // untouched. Fixing the recognition regex to span `and` is a DIFFERENT change to a detector this
  // task does not own; refusing is the correct action for a repairer that cannot see the whole claim.
  const afterClaim = body.slice(firstIdx + claim.length);
  if (/^\s*(?:,\s*)?and\s+\S*[./]\S*/i.test(afterClaim)) return undefined;

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

/** W1-T4263: the fix rung's fallback for {@link acceptanceGateBodyRepair}. An added test wins; otherwise, and only
 *  when the body takes the fallback at all, a line the checkout's diff adds; the static grep last, ledgered. */
function bodyRepairFallback(
  body: string,
  headOnly: AcceptanceCriterion[],
  readDiff: () => string | undefined,
  log?: (step: string, extra?: Record<string, unknown>) => void,
  context: Record<string, unknown> = {},
): AcceptanceCriterion[] {
  if (headOnly.length) return headOnly;
  const check = acceptanceAuthorTimeCheck(body);
  if (check.ok || (check.defect !== "no-header" && check.defect !== "empty-proofs")) return host.ACCEPTANCE_GATE_BODY_REPAIR_FALLBACK;
  return host.diffAnchoredFallback(readDiff(), host.ACCEPTANCE_GATE_BODY_REPAIR_FALLBACK, "body-repair", log, context);
}

function remedyFilePath(remedy: ReachableRemedyFileInput): string {
  return typeof remedy === "string" ? remedy : remedy.path;
}

function declaredGateRemedyEntry(gate: string, file: string): string {
  return `FAST_GATE_STEPS[job="${gate}"].remedyFiles includes "${file}"`;
}

function missingGateRemedyEntry(gate: string, file: string): string {
  return `MISSING FAST_GATE_STEPS remedyFiles entry for gate "${gate}" and file "${file}"`;
}

function failureOutputNamesRemedyPath(failure: Pick<CiFailure, "logTail">, path: string): boolean {
  return failure.logTail
    .split(/\r?\n/)
    .some((line) => /\bTO FIX:/i.test(line) && /\bedit\b/i.test(line) && line.includes(path));
}

function gateRemedyScopeDeadlock(
  newOutOfScopePaths: readonly string[],
  reachableRemedyFiles: readonly ReachableRemedyFileInput[],
  failingChecks: readonly Pick<CiFailure, "name" | "logTail">[],
): FixRungGateRemedyScopeDeadlock | undefined {
  const declaredRemedies = reachableRemedyFiles.filter((r): r is RemedyFileForGate => typeof r !== "string");
  for (const file of newOutOfScopePaths) {
    const declared = declaredRemedies.find((r) => r.path === file);
    if (declared) {
      return {
        disposition: host.FIX_RUNG_GATE_REMEDY_SCOPE_DEADLOCK_DISPOSITION,
        gate: declared.job,
        file,
        declaringEntry: declaredGateRemedyEntry(declared.job, file),
        declaringEntryExists: true,
        source: "registry",
      };
    }
  }
  for (const file of newOutOfScopePaths) {
    const failure = failingChecks.find((f) => failureOutputNamesRemedyPath(f, file));
    if (failure) {
      return {
        disposition: host.FIX_RUNG_GATE_REMEDY_SCOPE_DEADLOCK_DISPOSITION,
        gate: failure.name,
        file,
        declaringEntry: missingGateRemedyEntry(failure.name, file),
        declaringEntryExists: false,
        source: "ci-output",
      };
    }
  }
  return undefined;
}

function fixRungScopeStandDownReason(
  currentDiffFiles: readonly string[],
  baselineDiffFiles: readonly string[],
  declaredFiles: readonly string[] | undefined,
  reachableRemedyFiles: readonly ReachableRemedyFileInput[] = [],
  failingChecks: readonly Pick<CiFailure, "name" | "logTail">[] = [],
  registrationChanges: readonly RegistrationChange[] = [],
):
  | {
      reason: string;
      scopeKind: "files" | "plan";
      newOutOfScopePaths: string[];
      gateRemedyDeadlock?: FixRungGateRemedyScopeDeadlock;
    }
  | undefined {
  if (!declaredFiles || declaredFiles.length === 0) return undefined;
  // W1-T5118: the role is read from the inherited diff — a plan-only filing stays plan-scoped even
  // when its shard declares future src/test paths. The SAME selection `renderFixPrompt` reads.
  const regime = fixScopeRegime(declaredFiles, baselineDiffFiles);
  const planOnlyTask = regime === "plan";
  const planFiling = planOnlyTask && !declaredFiles.every(isInPlanScope);
  const reachableRemedyPaths = reachableRemedyFiles.map(remedyFilePath)
    .filter((path) => !ADDITIVE_REGISTRATION_SURFACES.some((row) => row.path === path));
  // W1-T2653: widen the comparison set for THIS call only — never plan-only (see doc above).
  const effectiveDeclaredFiles = planOnlyTask
    ? declaredFiles
    : reachableRemedyPaths.length > 0
    ? [...declaredFiles, ...reachableRemedyPaths]
    : declaredFiles;
  const alreadyOutOfScope = new Set(outOfDeclaredScopeFiles(baselineDiffFiles, effectiveDeclaredFiles, [], regime));
  const newOutOfScopePaths = outOfDeclaredScopeFiles(currentDiffFiles, effectiveDeclaredFiles, registrationChanges, regime).filter(
    (f) => !alreadyOutOfScope.has(f),
  );
  if (newOutOfScopePaths.length === 0) return undefined;
  const scopeKind: "files" | "plan" = planOnlyTask ? "plan" : "files";
  const reason =
    scopeKind === "plan"
      ? `a fix worker added path(s) outside plan scope on a plan-only PR: ${newOutOfScopePaths.join(", ")} — ` +
        (planFiling
          ? `this PR is a plan-only filing (every path it carried before this rung is plan-scoped), so its ` +
            `declared future paths are not yours to build here: a repair may only touch ${host.PLAN_SCOPE_PATHS}`
          : `every file this task declares is plan-scoped, so a repair may only touch ${host.PLAN_SCOPE_PATHS}`) +
        `, never a src/test path, or the next round's rule-15 refusal fires on the file this ` +
        `rung itself wrote`
      : `a fix worker added path(s) outside the declared scope: ${newOutOfScopePaths.join(", ")} — declared ` +
        `files: ${declaredFiles.join(", ")} — dispatching another strike would compound on a PR the next ` +
        `round's rule-15/rule-25 refusal already can't recover from`;
  return {
    reason,
    scopeKind,
    newOutOfScopePaths,
    gateRemedyDeadlock: gateRemedyScopeDeadlock(newOutOfScopePaths, reachableRemedyFiles, failingChecks),
  };
}

/** W1-T2804: the sha a gate verdict was read for, or `undefined` when the reader did not report
 *  one. Undefined PINS NOTHING and every consumer falls back to its own read — fail open, exactly
 *  as before this task, so a stub that returns a bare verdict changes no behavior. */
function ciGateSha(r: CiGateOutcome | "green" | "red" | "timeout"): string | undefined {
  return typeof r === "string" ? undefined : r.sha;
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

function reportSubstituteStandDownReason(
  unmet: readonly CriterionVerdict[],
  capped: boolean,
  substituteCause: import("../../lib/review.js").ReportSubstituteCause | undefined,
): string | undefined {
  if (!substituteCause) return undefined;
  if (!capped) return undefined;
  if (unmet.length === 0) return undefined;
  if (unmet.some((c) => c.proof_exec === "executed_fail")) return undefined;
  const who =
    substituteCause.kind === "never-fetched"
      ? substituteCause.fixMode
        ? `the "${substituteCause.fixMode}" fix mode never fetches it`
        : "this round never fetched it"
      : "a fetch was attempted and the read failed";
  return (
    `the review this round would dispatch against was judged with the PR body NOT READ (${who}) — its ` +
    `${unmet.length} unmet criteri${unmet.length === 1 ? "on names" : "a name"} an unread body, not a diff ` +
    `defect the next fix worker could resolve; standing down rather than spending a strike on a fault this ` +
    `rung cannot fix`
  );
}

// ── GENERATOR-BACKED GATE FIX (W1-T2551) ──────────────────────────────────────────────────────
//
// GROUND TRUTH this closes: every `<name>:check` npm script paired with a bare `<name>` script is
// a GENERATOR run in verify mode (docs-index/docs-index:check,
// learnings-index/learnings-index:check, cli-reference/cli-reference:check, capability-snapshot/
// capability-snapshot:check, learnings-assert/learnings-assert:check, as of this writing — NEVER
// hand-listed here, see {@link declaredGeneratorScriptFor}). Every one of those generators fails
// `--check` with the IDENTICAL sentence, `Run 'npm run <name>' and commit the result.` (grepped
// across scripts/generate-*.mjs and scripts/learnings-assert-check.mjs, not assumed) — a ci-log
// fix-rung dispatch whose failing check(s) print that sentence is handed to a full worker anyway
// today, which reaches the SAME command the gate already named at the cost of a whole worker spawn
// and a strike against `strikeCap` for work that is entirely deterministic (this task's rationale
// (3)). This section closes that gap with a SEPARATE mechanism from {@link FIX_MODE_RULES} — no
// worker is spawned for the class this covers at all, so there is no prompt-rendering mode to add;
// {@link runFixRung} short-circuits BEFORE a worker would ever be dispatched (see its own `W1-T2551
// SITE`, before `strikes++`).
//
// OUT OF SCOPE, NAMED (this task's rationale (5), unchanged here): (a) any gate whose fix is not a
// generator run — {@link generatorFixFor} returns `undefined` for it and it reaches the ordinary
// rung exactly as before; (b) the merge-conflict rung's OWN regenerable-artifact admission
// (`REGENERABLE_ARTIFACT_GENERATORS`, lib/sweep.ts, W1-T2548) — a hand-maintained PATH→generator
// table for a DIFFERENT rung (the conflict rung, not this one), deliberately NOT reused or kept in
// sync here: this class derives its pairing from package.json's own declared scripts instead (see
// below), and the two tables answering the same question two different ways is this task's own
// acceptance criterion, not an oversight.

/**
 * Read the generator/`:check` pairing OFF package.json's own declared `scripts` map — NEVER a
 * hand-maintained table like {@link REGENERABLE_ARTIFACT_GENERATORS} (lib/sweep.ts, a DIFFERENT
 * rung's admission list, out of scope here per this task's rationale (5b)). `checkOrGeneratorName`
 * may be given either shape (`"docs-index:check"` or bare `"docs-index"`); the BASE name is
 * returned only when BOTH the bare name and its `:check` counterpart are declared scripts — that
 * shared declaration IS the pairing itself, not an inference drawn from it. `undefined` for any
 * name package.json does not declare BOTH halves of, including a `:check` script with no bare
 * counterpart at all (`api-client:check`, `task-id-existence:check`, `no-hand-rolled-fetch:check`,
 * `worker-branch-shape:check` — measured on this repo's own package.json, 2026-08 — each of those
 * is fixed by something other than "run the paired generator", so none belongs in this class).
 */
function declaredGeneratorScriptFor(
  scripts: Readonly<Record<string, string>>,
  checkOrGeneratorName: string,
): string | undefined {
  const suffix = ":check";
  const base = checkOrGeneratorName.endsWith(suffix) ? checkOrGeneratorName.slice(0, -suffix.length) : checkOrGeneratorName;
  if (base.length === 0) return undefined;
  if (!Object.prototype.hasOwnProperty.call(scripts, base)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(scripts, `${base}${suffix}`)) return undefined;
  return base;
}

/**
 * ONE failing check's declared generator fix, or `undefined` when this check is OUT of the class
 * this task targets (acceptance criterion 3: a check with no generator counterpart still reaches
 * the ordinary rung unchanged). Requires BOTH: the check's own log names a remedy generator (the
 * sentence {@link remedyGeneratorNamedInLog} matches), AND that name is a REAL package.json-
 * declared pairing ({@link declaredGeneratorScriptFor}) — never trusting the log's naming alone.
 * The log is attacker-influenceable CI output (the SAME threat model W1-T210 fenced ci-log content
 * for elsewhere in this rung); bounding to a script package.json itself already declares is what
 * stops a crafted log from naming an arbitrary command and having it run.
 */
function generatorFixFor(failure: Pick<CiFailure, "logTail">, scripts: Readonly<Record<string, string>>): string | undefined {
  const named = remedyGeneratorNamedInLog(failure.logTail);
  return named === undefined ? undefined : declaredGeneratorScriptFor(scripts, named);
}

/**
 * TRUE only when EVERY failure in `failures` names a declared generator fix — a MIXED batch (one
 * generator-fixable check beside an unrelated real defect) still reaches the ordinary rung
 * unchanged (acceptance criterion 3): running only the fixable generator would leave the other
 * failure unaddressed while looking, from the ledger, like progress was made. `false` on an empty
 * list — there is nothing here to fix.
 */
function allCiFailuresAreGeneratorFixable(
  failures: readonly Pick<CiFailure, "logTail">[],
  scripts: Readonly<Record<string, string>>,
): boolean {
  return failures.length > 0 && failures.every((f) => generatorFixFor(f, scripts) !== undefined);
}

/**
 * Resolve a ci-log fix-rung round WITHOUT spawning a worker — the mechanism this whole section
 * exists to add (acceptance criterion 1). Every external interaction is injected (mirrors
 * {@link runFixRung}'s own discipline) so this is unit-testable with fakes: no real spawn, git,
 * or npm invocation in the test suite.
 *
 * SAFETY (rationale (4), acceptance criterion 4): each generator's OWN `<name>:check` is re-run
 * AFTER regenerating and BEFORE any commit — a generator that runs clean but still leaves its
 * check red is a real defect the next fix worker must look at, never papered over by committing a
 * non-fix. Nothing here ever hand-composes file content (acceptance criterion 5): the only writes
 * this function can produce are (1) whatever `deps.runScript` itself writes to the worktree by
 * running the repo's OWN generator command, and (2) `deps.commit`, which is expected to `git add
 * -A && git commit` whatever that generator left behind — never a diff this function authors.
 *
 * Returns `{ applied: false, generators: [] }` immediately, calling NOTHING, when `failures` is
 * not entirely generator-fixable ({@link allCiFailuresAreGeneratorFixable}) — the caller's own
 * gate before calling this, restated here so this function is safe to call unconditionally too.
 */
async function runGeneratorFixForCiFailures(opts: {
  failures: readonly CiFailure[];
  scripts: Readonly<Record<string, string>>;
  worktreePath: string;
  taskId: string;
  branch: string;
  deps: {
    runScript: (script: string, cwd: string) => Promise<{ status: number; stdout: string; stderr: string }>;
    commit: (opts: { cwd: string; message: string }) => Promise<{ sha: string; changed: boolean }> | { sha: string; changed: boolean };
    // W1-T2610: `expectedHeadSha` is the sha `commit` above just returned — threaded through so
    // the real `gitPushRunBranch` leaf underneath (see the run-loop's `push:` closure) can
    // confirm it actually landed rather than silently no-op'ing a rewound ref.
    push: (opts: { cwd: string; branch: string; expectedHeadSha?: string }) => Promise<void> | void;
  };
}): Promise<GeneratorFixResult> {
  if (!allCiFailuresAreGeneratorFixable(opts.failures, opts.scripts)) {
    return { applied: false, generators: [] };
  }
  const generators: string[] = [];
  for (const f of opts.failures) {
    const g = generatorFixFor(f, opts.scripts);
    if (g !== undefined && !generators.includes(g)) generators.push(g);
  }
  for (const generator of generators) {
    const genResult = await opts.deps.runScript(generator, opts.worktreePath);
    if (genResult.status !== 0) {
      return {
        applied: false,
        generators,
        escalate: { generator, detail: `generator itself exited ${genResult.status}: ${(genResult.stderr || genResult.stdout || "").trim()}` },
      };
    }
  }
  // The generator is the AUTHOR (rationale (4)) — re-run its OWN `:check` to confirm the fresh
  // regeneration the loop above just wrote actually satisfies the gate, BEFORE committing
  // anything. Never trust the generator's own exit 0 alone.
  for (const generator of generators) {
    const checkResult = await opts.deps.runScript(`${generator}:check`, opts.worktreePath);
    if (checkResult.status !== 0) {
      return {
        applied: false,
        generators,
        escalate: {
          generator,
          detail: `regenerated output still fails '${generator}:check': ${(checkResult.stderr || checkResult.stdout || "").trim()}`,
        },
      };
    }
  }
  const commitResult = await opts.deps.commit({
    cwd: opts.worktreePath,
    message: `fix(${opts.taskId}): regenerate ${generators.join(", ")}\n\nGenerator-backed gate fix (W1-T2551) — committing\n${generators
      .map((g) => `'npm run ${g}'`)
      .join(", ")}'s own output, never a hand edit.\n\nRemudero-Task: ${opts.taskId}`,
  });
  if (!commitResult.changed) {
    // Every check re-ran green already with nothing to stage — a race (something else
    // regenerated it between the failing read and this attempt's own re-check) or the
    // committed artifact was already fresh. Either way, nothing to push, nothing to escalate.
    return { applied: true, generators };
  }
  // W1-T2610: pass the sha `commit` above just minted — the leaf's post-condition confirms
  // this exact sha (not just "something") landed, rather than a rewound ref pushing nothing.
  await opts.deps.push({ cwd: opts.worktreePath, branch: opts.branch, expectedHeadSha: commitResult.sha });
  return { applied: true, generators, commitSha: commitResult.sha };
}

function summarizeCiFailure(f: CiFailure): string {
  const rawLines = (f.logTail ?? "").split("\n");
  const diagnostic = rawLines
    .map((l) => l.replace(CI_LOG_LINE_PREFIX_RE, "").trim())
    .find(
      (l) => l.length > 0 && !CI_LOG_BANNER_RE.test(l) && !CI_LOG_BARE_TIMESTAMP_RE.test(l) && CI_LOG_DIAGNOSTIC_RE.test(l),
    );
  if (diagnostic) return `${f.name} — ${diagnostic}`;
  const firstLine = rawLines.map((l) => l.trim()).find((l) => l.length > 0);
  return firstLine ? `${f.name} — ${firstLine}` : f.name;
}

/**
 * W1-T1279 (design note (iii)/(v)) — the exhaustion escalation's TRAJECTORY line: which check
 * name(s) were red at SOME point during this rung but are absent from the checks still red at
 * exhaustion. Named explicitly so the escalation can say what earlier strikes REPAIRED, not only
 * the final outcome — issues/2642 read "checks did not go green" across every strike even though
 * the branch behind it shows two different real defects, each fixed, before a THIRD, unrelated
 * check failed. `undefined` when nothing was ever red besides what still is (the ordinary
 * single-strike exhaustion) — no line renders for that case, so this never lengthens the common
 * escalation.
 */
function renderCiTrajectoryLine(everRedNames: ReadonlySet<string>, stillRedNames: readonly string[]): string | undefined {
  const stillRed = new Set(stillRedNames);
  const repaired = [...everRedNames].filter((n) => !stillRed.has(n)).sort();
  if (repaired.length === 0) return undefined;
  return `Earlier strike(s) already repaired: ${repaired.join(", ")}.`;
}

/**
 * W1-T487: render one of `runFixRung`'s three exhaustion-escalation evidence
 * blocks (conflicting files / failing checks / unmet criteria). Each was a
 * bare `.map().join("\n")` — silent on an empty list, so the heading above it
 * (`Conflicting file(s):`, `Failing check(s):`, `Unmet criteria:`) rendered
 * with nothing after it: a report that names a cause and supplies no
 * instance. `collected` tells the reader WHICH kind of empty this is — the
 * two are different and indistinguishable from a bare heading alone:
 * evidence that was never gathered for this rung at all (`false`), versus
 * evidence that WAS checked and came back with nothing outstanding
 * (`true`). Either way the escalation still fires (design note iii) — this
 * only changes what the body says, never whether it is sent.
 */
function renderEscalationEvidence<T>(items: readonly T[], format: (item: T) => string, collected: boolean): string {
  if (items.length > 0) return items.map(format).join("\n");
  return collected ? "(no evidence — this was checked and is empty)" : "(no evidence — this was never collected for this rung)";
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
function branchAuthorshipStandDownReason(
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
 * W1-T1284: a CONTENT snapshot of the local worktree {@link runFixRung} dispatches its strikes
 * into — never a pointer (a tree sha two different commits could share) and never anything about
 * `origin/main` (the base must never enter this identity — see {@link unchangedTreeStandDownReason}'s
 * own doc for why). Three fields, re-derived from PrimeIntellect-ai/prime-agent's
 * `captureGitWorktreeSnapshot` (`e319a66d`, packages/coding-agent/src/core/autonomous.ts): `status`
 * (tracked modifications, staged or not — `git status --porcelain`), `diff` (the SAME uncommitted
 * content against `HEAD`, not just a path list — a byte changed with no path added must still
 * register), and `untrackedHash` (a hash of every untracked file's own bytes — an untracked ADD
 * changes neither of the other two fields). NOT PROPOSED: prime-agent's IPython-kernel substrate,
 * which this repo has no equivalent of.
 */

/**
 * W1-T1284: FAILS TOWARD RUNNING — mirrors prime-agent's own `gitWorktreeSnapshotsEqual`
 * (`!!a && !!b && ...`) exactly. An unreadable OR absent snapshot on EITHER side is never a
 * match, so a read failure can only ever cause the caller to spend the strike, never to
 * silently withhold one on a comparison it could not actually confirm.
 */
function worktreeSnapshotsEqual(a: WorktreeSnapshot | undefined, b: WorktreeSnapshot | undefined): boolean {
  return !!a && !!b && a.status === b.status && a.diff === b.diff && a.untrackedHash === b.untrackedHash;
}

function unchangedTreeStandDownReason(
  gateKey: string,
  previousFailure: { gateKey: string; snapshot: WorktreeSnapshot } | undefined,
  currentSnapshot: WorktreeSnapshot | undefined,
): { reason: string } | undefined {
  if (!previousFailure) return undefined; // first round, or the prior capture was unreadable
  if (previousFailure.gateKey !== gateKey) return undefined; // a different gate — real ground moved
  if (!worktreeSnapshotsEqual(previousFailure.snapshot, currentSnapshot)) return undefined; // real progress, or unreadable now — fail toward running
  return {
    reason:
      `worktree content is byte-identical to the snapshot taken the last time this same gate ` +
      `(${gateKey}) was about to be spent against — the previous strike changed nothing to re-check; ` +
      `standing down rather than spending another strike on an unchanged tree`,
  };
}

function openEscalationStandDownReason(
  headSha: string,
  candidate: OpenIssue | undefined,
  currentContractRevision?: string,
  current?: { conflictEvidenceCaptured: boolean; baseSha?: string },
): { reason: string } | undefined {
  if (!candidate) return undefined; // nothing open on this key — the ordinary path
  const candidateHead = escalationHeadSha(candidate.body);
  // STRICTER THAN THE MATCHER (both arms): a candidate naming NO head, or naming a DIFFERENT one,
  // never refuses a worker. The first arm is the legacy-issue case, the second is a genuinely new
  // push whose issue has not been filed yet — in both, the failure direction of guessing wrong is
  // "stop fixing things", so both fail open.
  if (candidateHead === undefined || candidateHead !== headSha) return undefined;
  const candidateRevision = escalationContractRevision(candidate.body);
  // W1-T3579: a genuine disagreement between the RECORDED and CURRENT contract revision means the
  // question this issue asked has since changed underneath it — re-admit rather than stand down.
  // Either side missing (a legacy issue, or a caller with no live task to hash) says nothing, so
  // the original head-only stand-down applies unchanged — fail toward standing down, never toward
  // mass-retrying, on anything short of a positively OBSERVED contract change.
  if (candidateRevision !== undefined && currentContractRevision !== undefined && candidateRevision !== currentContractRevision) {
    return undefined;
  }
  if (current && clearedConflictEscalationCause(candidate.body, current) !== undefined) return undefined;
  return {
    reason:
      `a needs-human escalation for this exact (task, PR, head ${headSha}, cause) is ALREADY OPEN and ` +
      `awaiting a human (${candidate.url}) — a strike here would re-ask a question already in front of ` +
      `someone and append to that same issue; standing down until it is closed, the head moves, or the ` +
      `task contract changes`,
  };
}

function resolveClearedEscalation(
  issues: IssueGateway,
  log: (step: string, extra?: Record<string, unknown>) => void,
  taskId: string,
  issueUrl: string,
  clearedCause: string,
): void {
  const comment =
    `Resolved by change (W1-T5908): the cause this escalation was raised for has cleared — ${clearedCause}. ` +
    `The fleet's merge-conflict repair is dispatched for this PR, so no human decision is pending; closing automatically.`;
  const row = { task_id: taskId, superseded_issue_url: issueUrl, resolved_by: "change", cleared_cause: clearedCause };
  try {
    if (!issues.closeWithComment) throw new Error("issue gateway cannot close issues");
    issues.closeWithComment(issueUrl, comment);
  } catch (err) {
    log("escalation.superseded", { ...row, delivered: false, failure: String((err as Error)?.message ?? err) });
    return;
  }
  log("escalation.superseded", { ...row, delivered: true });
}

async function fixRungStandDownReason(
  readLiveState: ((prUrl: string) => LiveStateResult | Promise<LiveStateResult>) | undefined,
  prUrl: string,
  site: string,
  log: (step: string, extra?: Record<string, unknown>) => void,
  authorship?: {
    readLiveHead: (prUrl: string) => LiveHeadResult | Promise<LiveHeadResult>;
    rungOwnHeadSha: string | undefined;
  },
  /**
   * W1-T1278 (condition A) — the required check name(s) THIS round's ci-log evidence currently
   * believes are red (`currentCiFailures`' own names), plus a FRESH reader of the PR's current
   * status-check rollup — never the stale evidence that made those names red in the first place.
   * Omitted (not ci-log mode, or no fresh reader wired) skips this check entirely — fail open,
   * exactly like `authorship` above.
   */
  redCheckSupersession?: {
    redNames: readonly string[];
    readRollup: (prUrl: string) => RollupCheckEntry[] | Promise<RollupCheckEntry[]>;
  },
  /**
   * W1-T1278 (condition B) — a fresh reader of THIS pull request's own merge facts, consulted
   * ONLY when the rung is NOT already dispatching in merge-conflict mode (the caller omits this
   * param whenever `currentMergeConflict !== undefined` — that mode already owns a dirty read
   * correctly; see design note (iv), "hands the PR back to the sweep's own conflicted
   * disposition, which owns merge-conflict mode already"). `prNumber` is `undefined` when
   * `prUrl` does not parse — the check is then skipped, never guessed.
   */
  mergeConflictCheck?: {
    prNumber: number | undefined;
    readMergeFacts: (prNumber: number) => FixRebaseMergeFacts | Promise<FixRebaseMergeFacts>;
  },
  /**
   * W1-T1284 — the identity of the gate THIS round is about to spend a strike against
   * (`gateKey`, derived by the caller — see `runFixRung`'s own call site), the snapshot/gateKey
   * pair recorded the last time this rung was about to spend a strike (`previousFailure`,
   * `undefined` on the first round or after an unreadable capture), and a FRESH capture of the
   * worktree right now. Omitted (no `deps.captureWorktreeSnapshot` wired) skips this check
   * entirely — fail open, exactly like every other optional reason source here.
   */
  unchangedTree?: {
    gateKey: string;
    previousFailure: { gateKey: string; snapshot: WorktreeSnapshot } | undefined;
    currentSnapshot: WorktreeSnapshot | undefined;
  },
  foreignTree?: { round: number; branch: string; currentWorktreePath: string; birthSnapshot: WorktreeSnapshot | undefined; currentSnapshot: WorktreeSnapshot | undefined; registeredWorktrees?: readonly RegisteredWorktree[] },
  /**
   * W1-T2799 — the escalation THIS round's strike would eventually re-file if it changed nothing
   * (`key`), the head it would be filed against (`headSha`), and the finder that answers whether
   * such an issue is already open. `find` is INJECTED rather than called here so this function
   * stays free of the issue gateway, the same seam `readRollup`/`readMergeFacts` above already
   * use; the caller wires it to {@link findDuplicateEscalation} itself, never a second matcher.
   * Omitted (a gateway with no `listOpen`, or any site other than `rung.strike`) skips this check
   * entirely — fail open, exactly like every other optional reason source here.
   *
   * CHECKED LAST of the six, deliberately: it is the only source that costs an issue-list read
   * this round would not otherwise perform, so the five cheaper answers — all of them either
   * already-fetched facts or reads the rung needs regardless — get to answer first.
   *
   * W1-T3579 — `key.contractRevision` (set by the caller from {@link taskContractRevision}) is
   * read straight off THIS `key`, never a second parameter here: it is both the 4th dedup
   * dimension `find` searches with and the CURRENT revision {@link openEscalationStandDownReason}
   * compares a head-qualified candidate against, so the two can never drift apart.
   */
  openEscalation?: {
    headSha: string;
    key: EscalationDedupKey;
    find: (key: EscalationDedupKey) => OpenIssue | undefined;
    current?: { conflictEvidenceCaptured: boolean; baseSha?: string };
    resolve?: (candidate: OpenIssue, clearedCause: string) => void;
  },
): Promise<{ reason: string; foreignHead?: { headSha: string; author: string }; foreignTree?: ForeignTreeStandDown; unchangedTree?: true } | undefined> {
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

  // W1-T1278 (condition B) — checked BEFORE condition A: a dirty merge state means GitHub is
  // not even running checks, so it is the more fundamental blocker of the two (rationale (4):
  // "#2605 is also one of the three blocked_ci PRs ... that did NOT merge — condition A's
  // exception is condition B's instance").
  if (mergeConflictCheck && mergeConflictCheck.prNumber !== undefined) {
    let facts: FixRebaseMergeFacts | undefined;
    try {
      facts = await mergeConflictCheck.readMergeFacts(mergeConflictCheck.prNumber);
    } catch (error) {
      facts = undefined; // fail open — an unreadable merge-facts read never manufactures a stand-down
      log("fix.gate_read_error", { site, read: "merge_facts", error: String(error) });
    }
    if (facts?.mergeable === "CONFLICTING") {
      return {
        reason:
          "merge state is dirty (mergeable === false or mergeable_state === \"dirty\") — a conflicted PR " +
          "registers no new check runs, so a strike buys no information; standing down for the sweep's own " +
          "conflicted disposition rather than retrying blindly",
      };
    }
  }

  if (redCheckSupersession && redCheckSupersession.redNames.length > 0) {
    let rollup: RollupCheckEntry[] = [];
    try {
      rollup = await redCheckSupersession.readRollup(prUrl);
    } catch (error) {
      log("fix.gate_read_error", { site, read: "ci_rollup", error: String(error) });
      rollup = []; // fail open — an unreadable rollup leaves every red name "still red" (see below)
    }
    const stillRed = stillRedRequiredNames(redCheckSupersession.redNames, rollup);
    if (stillRed.length === 0) {
      return {
        reason:
          `the only red required check(s) this strike would target (${redCheckSupersession.redNames.join(", ")}) ` +
          `now show a later attempt already in flight or green on this head — standing down rather than spending a ` +
          `strike on an already-superseded reading`,
      };
    }
  }

  if (unchangedTree) {
    const unchanged = unchangedTreeStandDownReason(
      unchangedTree.gateKey,
      unchangedTree.previousFailure,
      unchangedTree.currentSnapshot,
    );
    if (unchanged) return { ...unchanged, unchangedTree: true };
  }

  if (foreignTree) { const foreign = foreignTreeStandDownReason(foreignTree); if (foreign) return { reason: foreign.reason, foreignTree: foreign }; }

  if (openEscalation) {
    // NO try/catch HERE, DELIBERATELY: the fail-open contract has exactly ONE owner, and it is
    // `findDuplicateEscalation` itself — "best-effort dedup: a failed read must never block the
    // escalation itself" is its own doc, and it swallows a throwing `listOpen` into `undefined`
    // before this ever sees it. A second catch around it would be an arm no production path can
    // reach (measured: `diff-coverage` flagged it as an added line with zero covering tests) and
    // a second, silently-drifting statement of the same guarantee.
    const candidate = openEscalation.find(openEscalation.key);
    const alreadyAsked = openEscalationStandDownReason(
      openEscalation.headSha,
      candidate,
      // W1-T3579: read straight off the SAME key the probe/producer both build below — never a
      // second computation — so the comparison and the dedup key can never disagree about which
      // revision "current" names.
      openEscalation.key.contractRevision,
      openEscalation.current,
    );
    if (alreadyAsked) return alreadyAsked;
    const clearedCause = candidate && escalationHeadSha(candidate.body) === openEscalation.headSha && openEscalation.current
      ? clearedConflictEscalationCause(candidate.body, openEscalation.current)
      : undefined;
    if (candidate && clearedCause) openEscalation.resolve?.(candidate, clearedCause);
  }

  return undefined;
}

/**
 * W1-T1095 (capability 1 of 3, RECORD-AND-RESUME — design note (i)): recognizes the "blocked
 * on #N" idiom in a review's own summary or an UNMET criterion's own reason — the phrase a
 * reviewer already writes when a criterion cannot be satisfied from INSIDE this diff because it
 * depends on another, not-yet-merged pull request. This is the gap rationale (3) measured:
 * `blocked_on`/`waiting_on_pr`/`depends_on_pr` all read ZERO across `src/` before this — there
 * was no way for the rung to even RECORD that the remedy lives elsewhere, so it spent strikes
 * (and eventually escalated) on work no fix worker could ever complete from inside the PR.
 *
 * Deliberately narrow: this matches ONE literal idiom, never infers a prerequisite from prose
 * shape or from a bare PR-number mention — a review that happens to REFERENCE a PR number in
 * passing (e.g. "see #40 for prior art") is never mistaken for a park-worthy blocker. Met
 * criteria are never consulted — only what's still failing can name what's still blocking.
 */
function outOfDiffBlockerFor(review: { summary: string; criteria: CriterionVerdict[] }): number | undefined {
  const texts = [review.summary, ...review.criteria.filter((c) => !c.met).map((c) => c.reason)];
  for (const text of texts) {
    const m = /\bblocked on #(\d+)\b/i.exec(text ?? "");
    if (m) return Number(m[1]);
  }
  return undefined;
}

/**
 * W1-T1095 (capability 1 — the resume half): has the prerequisite {@link outOfDiffBlockerFor}
 * named already MERGED? Mirrors every other live-state read in this file's fail-SAFE direction
 * ({@link LiveStateResult}'s own `ok:false` contract) — an indeterminate or failed read is never
 * treated as merged, so a `gh` hiccup keeps a parked PR parked (costs one skipped poll) rather
 * than risk spending a strike against a prerequisite that may still be open (the far worse
 * failure — see every other `ok:false` site in this file for the same asymmetric choice).
 */
function prerequisiteMerged(liveState: LiveStateResult | undefined): boolean {
  return liveState?.ok === true && liveState.state === "MERGED";
}

/**
 * W1-T2436 (capability 2 of 3 — THE MISSING PRODUCER): has THIS pull request already had a
 * prerequisite PR opened for its instrument entanglement? A pure "last one wins" fold over
 * `fix.prerequisite_opened` ledger rows, keyed by `pr_url` — mirrors {@link fixRebaseAlreadySpent}'s
 * own idiom (a ledger fold, never a second state file) so a re-invoked rung never dispatches a
 * SECOND worker to open a SECOND prerequisite for a split it has already produced.
 *
 * `undefined` means no prerequisite has been opened yet for this exact PR — the caller must
 * dispatch one. This is deliberately never keyed on the ENTANGLED PR's own review text: rationale
 * (2) — `detectInstrumentEntanglement` (lib/review.ts) is purely diff-derived, so a fresh review
 * of an UNCHANGED entangled diff reports `instrumentEntangled: true` forever, regardless of
 * anything this rung does. The ledger, not the review, is this capability's own memory.
 */
function priorPrerequisitePrFor(lines: ReadonlyArray<Record<string, unknown>>, prUrl: string): number | undefined {
  let found: number | undefined;
  for (const line of lines) {
    if (line.step === "fix.prerequisite_opened" && line.pr_url === prUrl && typeof line.prerequisite_pr === "number") {
      found = line.prerequisite_pr;
    }
  }
  return found;
}

/**
 * W1-T2436 (capability 2 of 3): the SpawnWorkerArgs for dispatching {@link renderPrerequisitePrPrompt}'s
 * worker — PURE, mirroring {@link buildFixRungDispatchArgs}'s own split (the arg-builder carries
 * the testable contract; the spawn wrapper, wired in `runFixRung`, is untested by design). Runs in
 * the SAME worktree/mount/budget/settings as an ordinary fix strike (no new config surface) but on
 * a FRESH session (`resumeSessionId` omitted) — this worker's job has nothing to resume from, and
 * the SAME restricted `FIX_WORKER_TOOLS` set every other fix-rung spawn already uses.
 */
function buildPrerequisitePrDispatchArgs(args: {
  task: { id: string; title: string };
  branch: string;
  prUrl: string;
  worktreePath: string;
  mount: Mount;
  settingsFile: string;
  config: Config;
  budgetUsd: number;
  runId: string;
  taskId: string;
  instrumentPaths: readonly string[];
  srcPaths: readonly string[];
  prerequisiteBranch: string;
}): SpawnWorkerArgs {
  return {
    cwd: args.worktreePath,
    permissionMode: "bypassPermissions",
    settingsFile: args.settingsFile,
    model: args.mount.model,
    mountProvider: args.mount.provider,
    effort: args.mount.effort,
    maxTurns: args.mount.maxTurns,
    maxBudgetUsd: args.budgetUsd,
    config: args.config,
    prompt: renderPrerequisitePrPrompt({
      task: args.task,
      branch: args.branch,
      prUrl: args.prUrl,
      instrumentPaths: args.instrumentPaths,
      srcPaths: args.srcPaths,
      prerequisiteBranch: args.prerequisiteBranch,
    }),
    tools: FIX_WORKER_TOOLS,
    runId: args.runId,
    taskId: args.taskId,
  };
}

/** W1-T5810: requires both readers; an `ok:false` head or throwing body read leaves the CI wait as before.
 *  Returns why the prerequisite fails admission, or undefined when the available evidence admits it. */
async function prerequisitePrAdmissionRefusal(
  prUrl: string,
  mintedBranch: string,
  read: { readLiveHead: (prUrl: string) => LiveHeadResult | Promise<LiveHeadResult>; fetchPrBody: (prUrl: string) => Promise<string> },
): Promise<string | undefined> {
  const head = await read.readLiveHead(prUrl);
  if (head?.ok && head.headRefName !== undefined && head.headRefName !== mintedBranch) {
    return `prerequisite ${prUrl} opened on head ${head.headRefName}, not the minted ${mintedBranch}`;
  }
  const body = await read.fetchPrBody(prUrl).catch((error: unknown) => ({ unreadable: String(error) }));
  const trailer = typeof body === "string" ? extractTaskTrailerId(body) : undefined;
  if (trailer !== undefined) return `prerequisite ${prUrl} body carries "Remudero-Task: ${trailer}" — a prerequisite credits no task`;
  const check = typeof body === "string" ? acceptanceAuthorTimeCheck(body) : undefined;
  return check && !check.ok ? `prerequisite ${prUrl} body refused (${check.defect}): ${check.message}` : undefined;
}

/**
 * W1-T1095 (capability 3): should this resumed pull request take its base before the next strike?
 *
 * WHY "BEHIND MAIN" IS NOT ITSELF THE JUSTIFICATION, MEASURED. This repository's `main`
 * protection reads `strict: false`, so GitHub does NOT refuse to merge a pull request merely
 * because its base moved — and with strict off it never even reports the `BEHIND` merge state
 * (the live board reads `BLOCKED`/`DIRTY` only). An arm gated on "behind" alone would therefore
 * be permanently inert here, which is the unwired-arm shape this fleet keeps filing.
 *
 * THE FIELD THAT DOES JUSTIFY IT IS `behind_by`, READ ONLY ON THE RESUME PATH, AND IT MEANS
 * SOMETHING SPECIFIC THERE: the review itself said this pull request is `blocked on #N`,
 * `prerequisiteMerged` has just read #N as MERGED, and a non-zero `behind_by` proves #N's merge
 * commit is NOT in this head's tree. So the next strike would re-run a fix worker against a
 * checkout that still lacks the remedy the review named, and fail for exactly the reason it
 * already failed. That is why the rebase is the remedy rather than a tidy-up.
 *
 * ORDER IS LOAD-BEARING — the two REFUSALS THAT PROTECT SOMETHING come first, so a passing
 * review or a spent bound can never be overridden by a later arm.
 */
function decideFixRebase(facts: FixRebaseFacts): FixRebaseDecision {
  if (facts.reviewPassed) {
    return {
      rebase: false,
      reason: "review already passed — a new head would discard the posted verdict and spend a review-orphan slot",
    };
  }
  if (facts.alreadyRebased) {
    return {
      rebase: false,
      reason: `already rebased once for this pull request (prerequisite #${facts.prerequisitePr}) — the bound is one rebase-and-retry`,
    };
  }
  if (facts.mergeable === "CONFLICTING") {
    return {
      rebase: false,
      reason: "the head conflicts with its base — the conflict path belongs to the sweep, not this rung",
    };
  }
  if (facts.mergeable !== "MERGEABLE") {
    return {
      rebase: false,
      reason: `merge state is not a definite MERGEABLE (${facts.mergeable ?? "unreadable"}) — refusing to rebase on state that cannot be resolved`,
    };
  }
  if (facts.behindBy === undefined) {
    return {
      rebase: false,
      reason: "cannot read how far behind its base this head is — refusing to rebase on an unreadable comparison",
    };
  }
  if (facts.behindBy <= 0) {
    return {
      rebase: false,
      reason: `the head already contains its base — prerequisite #${facts.prerequisitePr} is present, nothing to take`,
    };
  }
  return {
    rebase: true,
    reason: `prerequisite #${facts.prerequisitePr} merged and this head is ${facts.behindBy} commit(s) behind its base — updating the branch so the merged remedy is in the tree`,
  };
}

/**
 * W1-T1095 (capability 3): has this pull request already spent its ONE rebase? A pure fold over
 * rows already written — no new read, no timer, no state file. PR-NUMBER keyed, not task-id
 * keyed: the bound the shard states is "at most one rebase-and-retry per blocked PR", and one
 * task can own more than one pull request over its life.
 */
function fixRebaseAlreadySpent(lines: ReadonlyArray<Record<string, unknown>>, prNumber: number): boolean {
  return lines.some((l) => l.step === "fix.rebased" && l.pr_number === prNumber);
}

/** The two REST reads {@link runFixRebase} needs, behind one injectable seam so the decision
 *  above stays pure and this orchestrator stays thin. `mergeable` comes from `GET /pulls/{n}`,
 *  `behindBy` from `GET /compare/{base}...{head}` — both REST, never `--json` (GraphQL), the
 *  same quota split W1-T511 measured and this file already follows everywhere else. */

/**
 * W1-T1095 (capability 3): the I/O half — gather the two observations, ask {@link decideFixRebase},
 * and WRITE A ROW EITHER WAY. There is no silent exit from this function: every return has
 * ledgered a `fix.rebased`, `fix.rebase_refused` or `fix.rebase_failed` row naming its reason
 * first (design note ii — "every termination ... must write a row carrying its reason", and a
 * refusal to rebase is a termination like any other).
 *
 * ALL THE JUDGEMENT LIVES IN {@link decideFixRebase}; this function decides nothing except what
 * cannot be decided without I/O — whether the URL parses and whether the write dep is wired.
 */
async function runFixRebase(
  args: { prUrl: string; prerequisitePr: number; reviewPassed: boolean; strikes: number },
  io: {
    log: (step: string, extra?: Record<string, unknown>) => void;
    say: (msg: string) => void;
    ledgerLines: () => Array<Record<string, unknown>>;
    readMergeFacts?: (prNumber: number) => FixRebaseMergeFacts | Promise<FixRebaseMergeFacts>;
    updateBranch?: (prNumber: number) => { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }>;
  },
): Promise<{ rebased: boolean; reason: string }> {
  const target = host.prUrlTarget(args.prUrl);
  if (!target) {
    const reason = `pull request url does not parse (${args.prUrl}) — cannot address the update-branch endpoint`;
    io.log("fix.rebase_refused", { strike: args.strikes, blocked_on_pr: args.prerequisitePr, reason });
    return { rebased: false, reason };
  }
  if (!io.updateBranch) {
    const reason = "no update-branch dep wired — the rebase capability is not reachable from this call site";
    io.log("fix.rebase_refused", { strike: args.strikes, pr_number: target.number, blocked_on_pr: args.prerequisitePr, reason });
    return { rebased: false, reason };
  }

  const observed = io.readMergeFacts ? await io.readMergeFacts(target.number) : {};
  const mergeable =
    observed.mergeable === "MERGEABLE" || observed.mergeable === "CONFLICTING" || observed.mergeable === "UNKNOWN"
      ? observed.mergeable
      : undefined;
  const decision = decideFixRebase({
    prerequisitePr: args.prerequisitePr,
    reviewPassed: args.reviewPassed,
    mergeable,
    behindBy: observed.behindBy,
    alreadyRebased: fixRebaseAlreadySpent(io.ledgerLines(), target.number),
  });

  if (!decision.rebase) {
    io.log("fix.rebase_refused", {
      strike: args.strikes,
      pr_number: target.number,
      blocked_on_pr: args.prerequisitePr,
      behind_by: observed.behindBy,
      reason: decision.reason,
    });
    io.say(`fix rung: NOT rebasing — ${decision.reason}: ${args.prUrl}`);
    return { rebased: false, reason: decision.reason };
  }

  // W1-T7735: a repair-driven refresh keeps its own trigger but still writes its decision row.
  io.log(REFRESH_DECIDED_STEP, forcedRefreshFields({ prNumber: target.number, forcedBy: "fix-rebase", nowMs: systemClock.now() }));
  const result = await io.updateBranch(target.number);
  if (!result.ok) {
    const reason = `update-branch failed — ${result.error ?? "no error reported"}`;
    io.log("fix.rebase_failed", {
      strike: args.strikes,
      pr_number: target.number,
      blocked_on_pr: args.prerequisitePr,
      reason,
    });
    io.say(`fix rung: rebase FAILED — ${reason}: ${args.prUrl}`);
    return { rebased: false, reason };
  }

  io.log("fix.rebased", {
    strike: args.strikes,
    pr_number: target.number,
    blocked_on_pr: args.prerequisitePr,
    behind_by: observed.behindBy,
    reason: decision.reason,
  });
  io.say(`fix rung: REBASED — ${decision.reason}: ${args.prUrl}`);
  return { rebased: true, reason: decision.reason };
}

/**
 * W1-T1095 (capability 1 park / capability 3 rebase), W1-T2436 (capability 2 — THE MISSING
 * PRODUCER): the ONE park-or-resume-and-rebase orchestration this rung runs once a prerequisite
 * PR NUMBER is known — shared by BOTH producers of that number: the review-text-derived one
 * ({@link outOfDiffBlockerFor}, capability 1's own idiom) and the ledger-derived one
 * ({@link priorPrerequisitePrFor}, this task's own idiom). Extracted so "capabilities 1 and 3 are
 * consumed, never re-implemented" (this task's rationale (11)) is true of the ORCHESTRATION
 * around `prerequisiteMerged`/`runFixRebase`, not only of those two leaf functions — a single
 * call site owns the park/resume/rebase shape, so a future change to it (a new ledger field, a
 * different resume message) cannot drift between two independently-maintained copies.
 *
 * Returns a terminal {@link FixRungOutcome} (`"parked"` or `"rebased"`) for the caller to return
 * immediately, or `undefined` to mean "the prerequisite is merged but no rebase happened (already
 * contains the base, or refused) — fall through and proceed as an ordinary strike", exactly as
 * both call sites already did inline before this extraction.
 */
async function parkOrResumeOnPrerequisite(
  prerequisitePr: number,
  ctx: {
    prUrl: string;
    review: ReviewRunResult;
    strikes: number;
    retriggers: number;
  },
  deps: {
    readPrerequisiteState?: (prNumber: number) => LiveStateResult | Promise<LiveStateResult>;
    log: (step: string, extra?: Record<string, unknown>) => void;
    say: (msg: string) => void;
    ledgerLines: () => Array<Record<string, unknown>>;
    readMergeFacts?: (prNumber: number) => FixRebaseMergeFacts | Promise<FixRebaseMergeFacts>;
    updateBranch?: (prNumber: number) => { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }>;
  },
): Promise<FixRungOutcome | undefined> {
  const { review, strikes, retriggers, prUrl } = ctx;
  const prerequisiteState = deps.readPrerequisiteState ? await deps.readPrerequisiteState(prerequisitePr) : undefined;
  if (!prerequisiteMerged(prerequisiteState)) {
    const parkReason = `blocked on #${prerequisitePr} — a prerequisite outside this diff, not yet merged`;
    deps.log("fix.parked", { strike: strikes, blocked_on_pr: prerequisitePr, reason: parkReason });
    deps.say(`fix rung: PARKED — ${parkReason}; no strike spent, will resume once it merges: ${prUrl}`);
    return { outcome: "parked", review, strikes, retriggers, reason: parkReason, blockedOnPr: prerequisitePr };
  }
  deps.log("fix.resumed", { strike: strikes, blocked_on_pr: prerequisitePr });
  deps.say(`fix rung: RESUMING — prerequisite #${prerequisitePr} has merged; dispatching normally: ${prUrl}`);

  // W1-T1095 (capability 3 — REBASE): the prerequisite has merged, but this head does not yet
  // CONTAIN it. Take the base before spending the next strike, or the fix worker re-runs against
  // a checkout that still lacks the remedy the review named and fails identically. Every arm of
  // this call ledgers its reason, including every refusal — see `runFixRebase`.
  const rebase = await runFixRebase(
    {
      prUrl,
      prerequisitePr,
      // STRUCTURALLY FALSE HERE, AND SAID SO RATHER THAN DRESSED UP: this is only ever reached
      // while `review.state` is narrowed to `"failure"` (a passing review returns `outcome:
      // "fixed"` before any of this), so the compiler itself rejects `review.state === "success"`
      // as a comparison with no overlap. The guard still exists in `decideFixRebase` — it is the
      // operator's stated safety requirement and is proven by its own unit fixture — but at
      // today's call sites it is defence in depth, not a live arm. Naming that is the point; an
      // inert arm sold as a live one is the defect this fleet keeps filing.
      reviewPassed: false,
      strikes,
    },
    {
      log: deps.log,
      say: deps.say,
      ledgerLines: deps.ledgerLines,
      readMergeFacts: deps.readMergeFacts,
      updateBranch: deps.updateBranch,
    },
  );
  if (rebase.rebased) {
    // THE HEAD MOVED, SO THIS RUNG IS OVER — and this return is the whole reason the rebase is
    // safe. `update-branch` merges the base into the REMOTE head branch, so the local worktree
    // this rung would hand the next fix worker is now behind origin; that worker's
    // `gitPushRunBranch` is a plain (non-force) push and would be rejected as non-fast-forward,
    // and the sweep's push dep SWALLOWS failures ("the worker may already have pushed"), so the
    // strike would be spent and land nothing, silently. Returning here spends NO strike and lets
    // the next poll materialise a fresh worktree at the new head — the same re-invoked-later
    // shape parking already uses, never a local fetch/reset (which would take `.git/config.lock`
    // on a repo the fleet runs six lanes against).
    return { outcome: "rebased", review, strikes, retriggers, reason: rebase.reason, blockedOnPr: prerequisitePr };
  }
  return undefined;
}

// ── W1-T2403 — THE RETRIGGER-SHAPED FIX OUTCOME, ACCOUNTED SEPARATELY FROM A STRIKE ────────────
//
// MEASURED (this task's own rationale): 11 of 72 commits on fix-touched PRs are RETRIGGER-SHAPED
// — an empty commit, or a subject naming a known-flaky re-trigger — and 4 of 10 strike-exhausted
// PRs in that sample carried one before escalating with NO defect fixed. `fixStrikeCap` (below,
// UNTOUCHED in either direction) exists to stop a rung chasing a real defect forever; a retrigger
// for a check that is KNOWN flaky is a different thing, and spending a strike on it burns the
// cap on infrastructure noise, not on the diff. This section classifies a round's own commit(s)
// and, when EVERY new commit is retrigger-shaped, spends a SEPARATE, capped `retriggers` count
// instead of `strikes` — bounded by its OWN counter (never a timer: nothing here paces,
// throttles, or sleeps a call, W1-T1066), the same "bound the REPETITION, not the decision" shape
// W1-T2345's per-head disposition counter already uses.

/** One round's own new commit — only what {@link isRetriggerShapedCommit} needs. `changedFiles`
 *  is the number of files that commit touched (0 for an empty commit, `git commit --allow-empty`
 *  shaped); `subject` is that commit's own subject line, never its body (see the classifier's own
 *  doc for why body-matching was tried and dropped). */

/**
 * A commit is RETRIGGER-SHAPED if EITHER (a) it changed ZERO files — an empty commit — OR (b)
 * its SUBJECT LINE matches `re-?trigger`, or matches `flake|flaky|infra` together with
 * `ci|check|coverage|run|rerun` — the exact two-arm classifier this task's own rationale states
 * ("THE CLASSIFIER, STATED BEFORE THE NUMBER"), measured a LOWER BOUND by construction: a fix
 * that changed one real line for the wrong reason is invisible to it, and so is a retrigger whose
 * subject says nothing.
 *
 * SUBJECT-ONLY, deliberately never the commit body — matching the whole body swept up genuine
 * fixes whose bodies merely DISCUSS a flake (measured: 3 false positives, narrowed to 1 on the
 * subject alone — `852b5c3a`, the one named false positive this classifier accepts).
 *
 * The three word-match regexes are declared HERE, inside the function body, rather than at
 * module scope — a plain implementation detail of the one function that owns them (this
 * codebase's own idiom for a validator regex, e.g. the trailer regex inside
 * `extractTaskTrailerId` in lib/review.ts), never a shared or exported surface.
 */
function isRetriggerShapedCommit(commit: FixRoundCommit): boolean {
  if (commit.changedFiles === 0) return true;
  const subject = commit.subject;
  if (/re-?trigger/i.test(subject)) return true;
  return /flake|flaky|infra/i.test(subject) && /ci|check|coverage|run|rerun/i.test(subject);
}

/**
 * W1-T5535: the fix lane's learned acceptance arms. `runFixRung` is the ONLY producer, so every other lane's
 * auction weighs headroom alone, as before. The ledger read is async and cached; an unreadable ledger is named on
 * its own row and the round routes by headroom, never blocks.
 */
async function fixLearnedArmsFor(
  ledger: { ledgerPath: string; log: (step: string, extra?: Record<string, unknown>) => void;
    readFixRoutingRows?: (stateDir: string, nowMs: number) => Promise<Array<Record<string, unknown>>> },
  strike: { strike: number; round: string },
): Promise<FixLearnedArms | undefined> {
  const nowMs = systemClock.now();
  let rows: Array<Record<string, unknown>>;
  try {
    rows = await (ledger.readFixRoutingRows ?? readFixRoutingRows)(dirname(ledger.ledgerPath), nowMs);
  } catch (error) {
    ledger.log("fix.routing_learner_unavailable", { ...strike, reason: "ledger-read-failed", error: String(error) });
    return undefined;
  }
  const evidence = fixArmEvidence(rows, nowMs);
  return {
    evidence,
    weigh: (candidates, seed) => fixRoutingWeights(evidence, candidates, seed),
    onDecision: (fields) => ledger.log("fix.routing_decision", { ...strike, ...fields }),
  };
}

/** W1-T7096: the pre-judge fixed bound, for a caller that wires no judge. It announces itself on
 *  first use, so a production path that ever reaches it is visible in the ledger and on the console. */
function formerBoundStandIn(reached: () => boolean,
  log: (step: string, extra?: Record<string, unknown>) => void, say: (line: string) => void): FixProgressJudge {
  let announced = false;
  return async () => {
    if (!announced) {
      announced = true;
      log("fix.progress_judge_stand_in", { judge: "former_bound_stand_in" });
      say("fix rung: no progress judge wired — using the former fixed bound (W1-T7096 stand-in)");
    }
    return reached()
      ? { verdict: "escalate", loop: "former fixed bound reached (no progress judge wired)", reason: "unwired caller keeps the pre-W1-T7096 bound" }
      : { verdict: "continue", reason: "unwired caller keeps the pre-W1-T7096 bound" };
  };
}

/** W1-T5544: the ONLY paths a proof-repair round may stage — the PR's current changed paths under `test/` plus the task's
 *  declared `test/` paths. Never a `src/` path, a plan shard, or a census baseline. Sorted, de-duplicated. */
function proofRepairStageablePaths(prChangedPaths: readonly string[], taskFiles: readonly string[]): string[] {
  return [...new Set([...prChangedPaths, ...taskFiles].filter((p) => PROOF_REPAIR_TEST_PATH.test(p)))].sort();
}

/** W1-T5544: the prompt block that makes a gate-log round a proof-repair round. Spliced AFTER the proof-discrimination
 *  prompt (which already lists each stale claim/proof), and says outright where it overrides that text. */
function proofRepairPromptLines(input: {
  proofs: ProofDiscriminationEvidence["proofs"];
  stageable: readonly string[];
}): string[] {
  return [
    "",
    "PROOF-REPAIR ROUND (W1-T5544) — this round's MODE is proof-repair. Where this block differs from the",
    "proof-discrimination paragraph above, THIS BLOCK WINS.",
    `The required proof-discrimination check is RED: the ${input.proofs.length} proof(s) listed above pass at BOTH this PR's head and its`,
    "merge base, so they cannot show this PR changed anything. The plan's proof text is authoritative and the PR body is not read.",
    input.stageable.length > 0
      ? `You MAY edit ONLY these test paths: ${input.stageable.join(", ")}. Any other path — src/, the plan, a task shard, the PR body — is refused.`
      : "This PR has no test path you may stage, so make NO file edit; if the plan's proof itself is wrong, propose a PROOF_AMENDMENT instead.",
    "GOAL: every proof above must EXIST and DISCRIMINATE — pass at head, fail at the merge base. Two repairs have worked by hand:",
    "  - a `unit test:` proof names a test TITLE that does not exist: rename the test so its title carries the claim's distinctive words;",
    "  - a proof that already passes at the merge base: make a test assert the state THIS PR newly records, so it fails without the PR.",
    "Before pushing, the parent runs `rmd check-proof <proof> --base <merge-base>` for EVERY proof above in your worktree and pushes only",
    "if each now passes at head and fails at base. Otherwise the round is REFUSED (a refusal, not a strike) and nothing is pushed.",
    "If the PLAN's proof is itself wrong (it names behaviour this PR does not change), make no edit and end your report with the",
    "PROOF_AMENDMENT: block described above instead — claim and old_proof copied byte-for-byte; a parent-owned process validates it.",
  ];
}

/**
 * W1-T3434 (coverage-ratchet): THE PARENT-OWNED CAPPED-PROOF-AMENDMENT EFFECT, extracted whole out
 * of `runFixRung`'s proof-discrimination arm. That arm's body — proposal parsing, the ledger-key
 * lookup, the base-proof worktree build, and the `requestProofAmendment` dispatch itself — closed
 * directly over real process/network I/O with no seam a test could reach; a `diff-cov:` directive
 * cannot exempt a live worktree/GitHub write, and running it for real just to cover these lines
 * would spend an actual amendment PR on a test run. `io` mirrors {@link buildProofAmendmentWritePorts}'s
 * override surface (every field defaults to the real implementation, so production is unchanged)
 * plus the boundaries (proposal parsing, the merge-base proof directory build and its teardown) this
 * function itself calls around the ports. `requestProofAmendment` ITSELF stays a direct, literal
 * call — never behind its own override — because this task's own acceptance criteria grep for
 * that exact call site in this file's source text; every write it makes still goes through the
 * injected ports above, so nothing it does escapes this function's own fakes. Best-effort: any
 * throw here only logs `proof_amendment.error` — the caller's ordinary re-review proceeds
 * unaffected either way, exactly as before this extraction.
 */
function dispatchProofAmendmentWrite(
  params: {
    prUrl: string;
    taskId: string;
    worktreePath: string;
    config: Config;
    reviewBase: { owner: string; repo: string; headCheckoutDir: string };
    evidence: ProofDiscriminationEvidence;
    /** `workerTranscript(fixResult)` at the call site — the worker's PROOF_AMENDMENT proposal lives
     *  only in its own transcript, never in `reviewReport` (which this mode overwrites with the
     *  live PR body before this runs). */
    transcriptText: string;
    review: { state: ReviewRunResult["state"]; capped: boolean; criteria: ReviewRunResult["criteria"]; reviewerOutcome?: string };
    priorHeadSha: string;
    log: (step: string, extra?: Record<string, unknown>) => void;
    /** Lazy: only actually read once a non-empty proposal exists — mirrors the pre-extraction
     *  code, which never spent a ledger read on a round with nothing to validate. */
    getLedgerLinesNow: () => readonly Record<string, unknown>[];
  },
  io: {
    gitFn?: (worktreePath: string, args: string[]) => string;
    findShardFn?: typeof findTaskShard;
    worktreeAddFn?: typeof worktreeAdd;
    worktreeRemoveFn?: typeof worktreeRemove;
    writeFileFn?: (absPath: string, text: string) => void;
    gitPushFn?: (worktreePath: string, branch: string, expectedHeadSha: string) => void;
    ghJsonFn?: GhApiFetcher;
    probeExistingPlanPrFn?: typeof probeExistingPlanPr;
    createPlanPrRestFn?: typeof createPlanPrRest;
    isPrMergedNowFn?: typeof isPrMergedNow;
    ghExecFn?: typeof ghExec;
    assertLiveWriteAllowedFn?: typeof assertLiveWriteAllowed;
    parseProofAmendmentProposalFn?: typeof parseProofAmendmentProposal;
    buildBaseProofDirFn?: typeof buildBaseProofDir;
    /** Deregisters the merge-base worktree the build cut from the head checkout; defaults to
     *  {@link releaseBaseProofDir}'s own remover, the hardened leaf it was cut through. */
    removeBaseWorktreeFn?: (repoDir: string, worktreePath: string) => void;
  } = {},
): void {
  const {
    gitFn,
    parseProofAmendmentProposalFn = parseProofAmendmentProposal,
    buildBaseProofDirFn = buildBaseProofDir,
    removeBaseWorktreeFn,
    ...portsIo
  } = io;
  let baseProof: BaseProofDir | undefined;
  try {
    const prMatch = params.prUrl.match(/\/pull\/(\d+)/);
    const prNumber = prMatch ? Number(prMatch[1]) : undefined;
    const proposal = parseProofAmendmentProposalFn(params.transcriptText);
    // No proposal ⇒ `validateProofAmendmentProposal` refuses immediately anyway (`no-proposal`) —
    // bail out here, BEFORE ever touching git or GitHub, rather than spending a real merge-base
    // worktree build on a round that has nothing to validate.
    if (prNumber === undefined || proposal.length === 0) return;
    const { owner, repo, headCheckoutDir } = params.reviewBase;
    const ledgerLinesNow = params.getLedgerLinesNow();
    baseProof = buildBaseProofDirFn(
      proposal.map((p) => ({ proof: p.newProof })),
      headCheckoutDir,
    );
    const gitOps = host.buildProofAmendmentGitOps(gitFn);
    const writePorts = host.buildProofAmendmentWritePorts(
      {
        taskId: params.taskId,
        worktreePath: params.worktreePath,
        config: params.config,
        owner,
        repo,
        prNumber,
        ledgerLinesNow,
        log: params.log,
        gitOps,
      },
      portsIo,
    );
    const amendmentOutcome: ProofAmendmentOutcome = requestProofAmendment(
      {
        taskId: params.taskId,
        prNumber,
        prUrl: params.prUrl,
        pr: {
          isOpen: true,
          planOnly: false,
          taskId: params.taskId,
          // The sweep sends capped evidence only from a posted SUCCESS review; its reconstruction's `failure` is a placeholder.
          reviewState: params.review.reviewerOutcome === "sweep-reconstructed" ? "success" : params.review.state,
          capped: params.review.capped,
          criteria: params.review.criteria.map((c) => ({ claim: c.claim, proof: c.proof, met: c.met })),
        },
        evidence: params.evidence,
        proposal,
        headSha: params.priorHeadSha,
        currentHeadSha: params.priorHeadSha,
        headCwd: headCheckoutDir,
        // A grep tree is a complete base for the grep-only proposal it was built from.
        baseCwd: baseProof.baseIsCheckout || baseProof.baseIsGrepTree ? baseProof.baseCheckoutDir : undefined,
      },
      writePorts,
    );
    params.log("proof_amendment.requested", {
      pr_number: prNumber,
      task_id: params.taskId,
      outcome: amendmentOutcome.kind,
      ...amendmentOutcome,
    });
  } catch (e) {
    params.log("proof_amendment.error", { error: String((e as Error)?.message ?? e) });
  } finally {
    // Every exit path: a `unit test:` proposal's worktree is deregistered, a grep tree deleted.
    releaseBaseProofDir(params.reviewBase.headCheckoutDir, baseProof, removeBaseWorktreeFn);
  }
}

async function censusSnapshotForCheck(
  root: string, path: string | undefined, merging: boolean,
  write: ((root: string, log: (step: string, extra?: Record<string, unknown>) => void) => string | undefined | Promise<string | undefined>) | undefined,
  log: (step: string, extra?: Record<string, unknown>) => void,
): Promise<string | undefined> {
  if (path === undefined || !merging || write === undefined) return path;
  return (await write(root, log)) ?? path;
}

function fixRoundLandingFields(landing: FixRoundLanding | undefined, workerSubtype: string, workerFixOutcome: string): Record<string, unknown> {
  if (landing === undefined) return {};
  if (landing.landed) return landing.remoteHead === undefined ? { push_outcome: "unverified" } : { push_outcome: "landed", remote_head_sha: landing.remoteHead };
  return { subtype: "push_failed", worker_subtype: workerSubtype, fix_outcome: "NOT_LANDED", worker_fix_outcome: workerFixOutcome,
    push_outcome: landing.outcome, ...(landing.cause === undefined ? {} : { push_failure_cause: landing.cause }),
    push_failure_reason: landing.reason.slice(0, 500), ...(landing.remoteHead === undefined ? {} : { remote_head_sha: landing.remoteHead }) };
}

/** W1-T5920 — the fix rung's FLAKE rerun: the same POST, a typed outcome (an in-flight HTTP 403
 *  is `deferred`), and its refusal logged under a fix-lane step, never the main-health one. */
function requeueActionsJobOutcome(
  owner: string,
  repo: string,
  failure: { name: string; jobId?: string },
  log: (step: string, extra?: Record<string, unknown>) => void,
  exec: (args: string[]) => unknown = ghExec,
): JobRequeueOutcome {
  return runStepsSync(host.requeueActionsJobSteps(owner, repo, failure, log, exec, "fix.flake_requeue.error"));
}

function ciFailurePromptEvidence(failures: readonly CiFailure[]): CiFailure[] {
  return failures.map((failure) =>
    failure.tailSource
      ? { ...failure, logTail: `failure detail source: ${failure.tailSource}\n${failure.logTail}` }
      : { ...failure },
  );
}

function verifiedReviewFindingsForFix(
  rows: ReadonlyArray<Record<string, unknown>>, taskId: string, prUrl: string, headSha: string,
): FixReviewFinding[] {
  const findings: FixReviewFinding[] = [];
  const seen = new Set<string>();
  const validPath = (path: unknown): path is string => typeof path === "string" && path.length > 0 &&
    path.length <= 240 && !isAbsolute(path) && !/[\\\x00-\x1f]/.test(path) && !path.split("/").includes("..");
  if (!/^[a-f0-9]{40,64}$/.test(headSha)) return findings;
  for (const row of rows) {
    if (row.step !== "review.finding" || row.task_id !== taskId || row.pr_url !== prUrl ||
        row.head_sha !== headSha || row.capture_state !== "verified") continue;
    const anchor = row.anchor as Record<string, unknown> | null | undefined;
    const producer = anchor?.changedProducer as Record<string, unknown> | null | undefined;
    if (!anchor || anchor.status !== "verified" || !validPath(anchor.path) ||
        !Number.isInteger(anchor.line) || Number(anchor.line) < 1 ||
        !["changed", "dependency"].includes(String(anchor.kind)) ||
        anchor.kind === "dependency" && !producer ||
        producer !== undefined && (!producer || !validPath(producer.path) || !Number.isInteger(producer.line) || Number(producer.line) < 1) ||
        typeof anchor.evidenceDigest !== "string" || !/^[a-f0-9]{64}$/.test(anchor.evidenceDigest) ||
        typeof row.finding_id !== "string" || !/^[a-f0-9]{64}$/.test(row.finding_id) ||
        !Number.isInteger(row.criterion_index) || Number(row.criterion_index) < 1 ||
        typeof row.category !== "string" || !/^[a-z][a-z0-9_-]{1,31}$/.test(row.category) ||
        !["low", "medium", "high"].includes(String(row.severity)) ||
        typeof row.mechanism !== "string" || !row.mechanism.trim() || row.mechanism.length > 500 ||
        !(row.remedy === null || typeof row.remedy === "string" && row.remedy.length <= 500) || seen.has(row.finding_id)) continue;
    seen.add(row.finding_id);
    findings.push({ criterionIndex: Number(row.criterion_index), path: anchor.path, line: Number(anchor.line),
      mechanism: row.mechanism, remedy: row.remedy as string | null });
  }
  return findings;
}

/**
 * W1-T4033 — THE REGIME A STRIKE IS SPENT UNDER, DERIVED FROM THE EVIDENCE IT WAS DISPATCHED
 * AGAINST. `criteria.some(...)` asks "did any proof execute", which is the right question ONLY
 * when there are criteria to ask it of. A ci-log or merge-conflict round has NONE by construction
 * — the reviewer runs only once CI is green — so `[].some(...)` returned `false` and every such
 * strike was tagged `keyword_only`, then amnestied by {@link priorStrikesFor} under the
 * `"executed"` regime. MEASURED 2026-09-22 on the live ledger: 200 of 200 `fix.dispatch` rows read
 * `keyword_only`, 190 of them ci-log or merge-conflict, and 153 dispatches printed `strike 1/2` —
 * `priorStrikes` read ZERO every time, so the cap never advanced and a futile loop never ended.
 *
 * THE EMPTY CASE IS THE WHOLE FIX: an empty criteria array is not evidence of keyword noise, it is
 * the absence of a reviewer verdict. What such a round WAS dispatched against — a named failing
 * check, a real conflicting file list — is executed evidence, so its strike must count. Every round
 * that HAS criteria is byte-for-byte unchanged, so W1-T199's amnesty keeps working for the case it
 * was built for: a judged round whose every proof was `not_executable`.
 */
function strikeRegimeForDispatch(criteria: ReadonlyArray<{ proof_exec?: unknown }>): StrikeRegime {
  if (criteria.length === 0) return "executed";
  return criteria.some((c) => c.proof_exec !== "not_executable") ? "executed" : "keyword_only";
}

/** W1-T5801: a repair the failing check's own log names (an existing src/ or scripts/ file) is reachable for THIS repair, via the shared reachableRemedyFiles list. */
function ciLogNamedSourcePaths(
  failures: readonly { name: string; logTail: string }[],
  repoDir: string,
): { path: string; job: string }[] {
  const found = new Map<string, string>();
  for (const failure of failures) {
    for (const match of failure.logTail.matchAll(/(?:^|[\s("'])((?:src|scripts)\/[\w./-]+\.[cm]?[jt]s)\b/g)) {
      const path = match[1]!;
      if (path.split("/").includes("..") || found.has(path) || found.size >= 5) continue;
      if (existsSync(join(repoDir, path))) found.set(path, failure.name);
    }
  }
  return [...found].map(([path, job]) => ({ path, job }));
}

/** Paths main changed since the merge base and this branch did not: a red there is main's, so refresh, never patch (#10369). */
function mainOwnedPaths(
  repoDir: string,
  paths: readonly string[],
  runGit: GitRunner = (args) => hostWorktreeGit(repoDir, args),
): { outcome: "compared" | "no-base" | "unreadable"; owned: string[]; reason?: string } {
  if (paths.length === 0) return { outcome: "compared", owned: [] };
  try {
    runGit(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"]);
  } catch (error) {
    return { outcome: "no-base", owned: [], reason: String(error) };
  }
  try {
    const base = runGit(["merge-base", "HEAD", "refs/remotes/origin/main"]).trim();
    const changed = (to: string) => new Set(runGit(["diff", "--name-only", "-z", base, to, "--", ...paths]).split("\0").filter(Boolean));
    const ours = changed("HEAD");
    return { outcome: "compared", owned: [...changed("refs/remotes/origin/main")].filter((path) => !ours.has(path)) };
  } catch (error) {
    return { outcome: "unreadable", owned: [...paths], reason: String(error) };
  }
}

function scopeAmendmentFromFixReport(report: string): string | undefined {
  const refusal = report.match(/^\d+\.\s+\[outside-declared-files\]\s+(.+)$/m)?.[1];
  const taskLine = report.match(/^task:\s+(.+)$/im)?.[1];
  const followUp = taskLine && /(?:out.of.scope|scope amendment|declared files)/i.test(taskLine) &&
    /(?:[\w.-]+\/)+[\w.-]+/.test(taskLine) ? taskLine : undefined;
  return (refusal ?? followUp)?.slice(0, 500);
}

/** W1-T4207: the capped `undeclared` list (plus `undeclared_omitted`) a refusal row carries. */
function undeclaredPathsLedgerFields(undeclared: readonly string[]): Record<string, unknown> {
  if (undeclared.length === 0) return {};
  const omitted = undeclared.length - COMMIT_REFUSED_PATH_CAP;
  return {
    undeclared: undeclared.slice(0, COMMIT_REFUSED_PATH_CAP),
    ...(omitted > 0 ? { undeclared_omitted: omitted } : {}),
  };
}

/**
 * W1-T4207: prompt lines naming what this task's latest fix strike could not commit. A refusal
 * returns the rung, so the next strike is a later invocation and the ledger is the only carrier.
 * A later round whose `fix.done` is not `commit_refused` supersedes it.
 */
function lastCommitRefusalPromptLines(
  ledgerLines: ReadonlyArray<Record<string, unknown>>,
  taskId: string,
  declaredFiles: readonly string[],
): string[] {
  let pending: Record<string, unknown> | undefined;
  let last: Record<string, unknown> | undefined;
  for (const line of ledgerLines) {
    if (line.task_id !== taskId) continue;
    if (line.step === "fix.commit_refused") pending = line;
    if (line.step === "fix.done") {
      last = line.subtype === "commit_refused" ? pending : undefined;
      pending = undefined;
    }
  }
  const paths = Array.isArray(last?.undeclared) ? last.undeclared.map(String) : [];
  if (!last) return [];
  const omitted = typeof last?.undeclared_omitted === "number" ? ` (and ${last.undeclared_omitted} more)` : "";
  return [
    "",
    `LAST ROUND'S COMMIT WAS REFUSED (W1-T4207): the harness could not commit it — ${String(last.reason)}. ` +
      (paths.length > 0 ? `Paths it could not commit: ${paths.join(", ")}${omitted}. ` : "") +
      `Declared files: ${declaredFiles.join(", ")}. ` +
      `Keep this strike's change inside \`files:\`; if the fix genuinely needs a path outside it, change ` +
      `nothing there and say in your REPORT that the task needs amending.`,
  ];
}

/** W1-T5999: did this worker END BY A SIGNAL? W1-T6027: read off the runner's observed `exit`, never the subtype. A codex
 *  stream that logged turn.failed or ended on a torn line reads `error_codex` whatever ended the child. A Claude worker
 *  killed before its result envelope throws instead; W1-T2402's catch owns that. */
function fixWorkerEndedBySignal(result: Pick<WorkerResult, "exit">): result is WorkerResult & { exit: { kind: "signal"; signal: string } } {
  return result.exit?.kind === "signal";
}

function derivedFixCommit(check: string | undefined, prUrl: string): { subject: string; reason: string } | undefined {
  const pr = prUrl.match(/\/pull\/(\d+)(?:\/|$)/)?.[1];
  if (check === undefined || check.trim().length === 0 || pr === undefined) return undefined;
  const prefix = "fix: repair ";
  const suffix = ` on #${pr}`;
  if (prefix.length + suffix.length >= 100) return undefined;
  const name = Array.from(check.trim().toLowerCase().replace(/\s+/g, " "))
    .slice(0, 100 - prefix.length - suffix.length).join("").trimEnd();
  return { subject: `${prefix}${name}${suffix}`, reason: `no COMMIT_MESSAGE; failing check ${check} on #${pr}` };
}

function fixDispatchResult(result: Awaited<ReturnType<FixDeps["dispatchFix"]>>, reason: string): { outcome: FixOutcome; reason: string } {
  if (dispatchFixSpent(result)) return { outcome: "fixed", reason };
  return { outcome: "refused", reason: typeof result === "object"
    ? `fix dispatch declined at the checkout claim (${result.ownerRecoveryReason})`
    : "fix dispatch was not accepted; no worker dispatched" };
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
 *   - OPEN, rounds already spent                      -> the progress judge decides
 *     (W1-T7096): escalate names the judged loop; continue dispatches.
 *   - anything else (no block evidence: mergeable,
 *     stale, contradictory-failure)                   -> refused, naming the reason.
 */
/**
 * W1-T4077 — THE CONSOLE'S "FIX NOW". The operator asking for a fix IS the decision to try again, so the strike
 * count does not turn the request into an escalation: the PR routes as a fresh attempt. Nothing else is relaxed —
 * {@link routeFix} still refuses a merged or closed PR and a PR with no failure evidence, and the dispatched round
 * keeps the fix rung's own branch claim and cost ceiling. The strike ledger itself is not touched.
 */
function requestedFixView(pr: OpenPrView): OpenPrView {
  return { ...pr, priorStrikes: 0 };
}

async function routeFix(
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
  let { disposition, reason } = deriveDisposition(pr, policy);
  let securityFix = disposition === "mergeable" &&
    pr.codeqlHeadAlerts?.headSha === pr.headSha && pr.codeqlHeadAlerts.alerts.length > 0 &&
    (pr.ciFailures ?? []).some(failure => failure.name === CODEQL_CHECK_NAME);
  if (securityFix) {
    if (!deps.ledgerLines) return { outcome: "refused", reason: "code-scanning ruling history unavailable; no security repair admitted" };
    try {
      securityFix = !deps.ledgerLines().some(row => row.step === CODE_SCANNING_FALSE_POSITIVE_STEP &&
        row.pr_number === pr.prNumber && row.head_sha === pr.headSha);
    } catch {
      return { outcome: "refused", reason: "code-scanning ruling history unavailable; no security repair admitted" };
    }
  }
  const ciFailures = withCodeqlAlertEvidence(pr, pr.ciFailures ?? []);
  if (securityFix) {
    disposition = "blocked-fixable";
    reason = "CodeQL failed with open high-severity alerts at this exact head";
  }
  let progressDecision: FixProgressVerdict | undefined;
  if (disposition === "blocked-fixable" && (pr.priorStrikes ?? 0) > 0) {
    // W1-T7096 (ruling 2026-10-09): a PR that already spent rounds gets another only when the progress
    // judge says so — never a fixed strike cap. Escalation still renders the operator question.
    const log = deps.log ?? (() => {});
    const judge = deps.fixProgressJudge ?? formerBoundStandIn(() => (pr.priorStrikes ?? 0) >= policy.strikeCap, log,
      (line) => console.error(line));
    const input = buildFixProgressInput({ taskId: pr.taskId, prNumber: pr.prNumber, headSha: pr.headSha,
      strikesSpent: pr.priorStrikes,
      currentRed: isBlockedCi(pr) || securityFix ? ciFailures.map((f) => f.name)
        : pr.unmetCriteria.filter((c) => !c.met).map((c) => `review:${c.claim}`),
      ledger: [...(deps.ledgerLines?.() ?? [])], formerCeiling: policy.strikeCap,
      parkedReason: "fix-strike: another operator-requested repair after prior rounds" });
    const decision = await judgeFixProgress(input, judge);
    log("fix.progress_judged", { pr_number: pr.prNumber, head_sha: pr.headSha, prior_strikes: pr.priorStrikes,
      site: "fix-strike", parked_reason: input.parkedReason, former_ceiling: input.formerCeiling, ...decision });
    if (decision.verdict === "unavailable") {
      return { outcome: "refused", reason: `fix progress judge unavailable: ${decision.reason}` };
    }
    if (decision.verdict === "escalate") {
      const loopReason = `fix progress loop after ${pr.priorStrikes} round(s): ${decision.loop} — ${decision.reason}`;
      await deps.escalate(pr, loopReason, renderClarificationQuestion(pr, loopReason, pr.strikeHistory ?? []));
      return { outcome: "escalated", reason: loopReason };
    }
    progressDecision = decision;
  }
  if (disposition === "blocked-fixable") {
    // W1-T100: the SAME evidence-shape selection runSweep uses, off the SAME
    // exported `isBlockedCi` predicate (never a second, independently-hardcoded
    // check) — a failing review carries the unmet set, a blocked_ci PR carries
    // ci-log evidence instead. W1-T2236: `actionableGateFailures` rides along on the
    // review-mode branch — the SAME structured, single-form remedy `DISPOSITION_RULES`'
    // `blocked-fixable` row (sweep.ts) already required to route a gate failure here at all
    // (see that row's own W1-T923 doc) — so the dispatch actually carries the remedy the
    // disposition named, instead of discarding it at this exact boundary.
    const dispatch = await deps.dispatchFix(
      pr,
      { ...(progressDecision ? { progressDecision, progressJudge: deps.fixProgressJudge,
          progressApproach: progressDecision.verdict === "change-approach" ? progressDecision.approach : undefined } : {}),
        ...(isBlockedCi(pr) || securityFix
        ? { unmetCriteria: [], ciFailures }
        : {
            unmetCriteria: pr.unmetCriteria,
            actionableGateFailures: pr.actionableGateFailures,
            instrumentEntangled: pr.instrumentEntangled,
            instrumentEntanglementPaths: pr.instrumentEntanglementPaths,
          }) },
    );
    return fixDispatchResult(dispatch, reason);
  }
  if (disposition === "conflicted") {
    // DISPOSITION_RULES admitted only an rmd-shaped run branch with captured
    // evidence. The production dispatch implementation repeats the stricter
    // task-specific head check before it writes; this routing seam carries the
    // evidence to that bounded worker and never attempts a textual side-take.
    const dispatch = await deps.dispatchFix(pr, { unmetCriteria: [], mergeConflict: pr.mergeConflict });
    return fixDispatchResult(dispatch, reason);
  }
  if (disposition === "refused-escalate") {
    // Same transport as the full sweep, but never through dispatchFix: a valid worker refusal is
    // an operator decision point, not an additional speculative strike.
    const question = renderClarificationQuestion(pr, reason, pr.strikeHistory ?? []);
    await deps.escalate(pr, reason, question);
    return { outcome: "escalated", reason };
  }
  return { outcome: "refused", reason: `${reason} (no block evidence to drive the rung)` };
}

  return {
    allCiFailuresAreGeneratorFixable,
    bodyRepairFallback,
    branchAuthorshipStandDownReason,
    buildPrerequisitePrDispatchArgs,
    censusSnapshotForCheck,
    ciFailurePromptEvidence,
    ciGateSha,
    ciLogNamedSourcePaths,
    ciRemedyComponent,
    decideFixRebase,
    declaredGateRemedyEntry,
    declaredGeneratorScriptFor,
    deriveChangesetClaimUpdate,
    derivedFixCommit,
    dispatchProofAmendmentWrite,
    failureOutputNamesRemedyPath,
    fixDispatchResult,
    fixLearnedArmsFor,
    fixRebaseAlreadySpent,
    fixRoundLandingFields,
    fixRungScopeStandDownReason,
    fixRungStandDownReason,
    fixWorkerEndedBySignal,
    formerBoundStandIn,
    gateRemedyScopeDeadlock,
    generatorFixFor,
    isRetriggerShapedCommit,
    lastCommitRefusalPromptLines,
    mainOwnedPaths,
    missingGateRemedyEntry,
    openEscalationStandDownReason,
    outOfDiffBlockerFor,
    parkOrResumeOnPrerequisite,
    prerequisiteMerged,
    prerequisitePrAdmissionRefusal,
    priorPrerequisitePrFor,
    proofRepairPromptLines,
    proofRepairStageablePaths,
    rebuildChangesetEnumeration,
    remedyFilePath,
    renderCiTrajectoryLine,
    renderEscalationEvidence,
    reportSubstituteStandDownReason,
    requestedFixView,
    requeueActionsJobOutcome,
    resolveClearedEscalation,
    routeFix,
    runFixRebase,
    runGeneratorFixForCiFailures,
    scopeAmendmentFromFixReport,
    splitEnumerationWrap,
    strikeRegimeForDispatch,
    summarizeCiFailure,
    unchangedTreeStandDownReason,
    undeclaredPathsLedgerFields,
    verifiedReviewFindingsForFix,
    worktreeSnapshotsEqual,
  };
}

export async function runFixRung(opts: Parameters<RunTaskCommandHost["runFixRung"]>[0],
  host: FixCommandHost,
): ReturnType<RunTaskCommandHost["runFixRung"]> {
  const {
    formerBoundStandIn,
    fixRungStandDownReason,
    resolveClearedEscalation,
    strikeRegimeForDispatch,
    renderEscalationEvidence,
    summarizeCiFailure,
    renderCiTrajectoryLine,
    bodyRepairFallback,
    allCiFailuresAreGeneratorFixable,
    runGeneratorFixForCiFailures,
    ciGateSha,
    ciLogNamedSourcePaths,
    mainOwnedPaths,
    ciRemedyComponent,
    fixRungScopeStandDownReason,
    outOfDiffBlockerFor,
    parkOrResumeOnPrerequisite,
    priorPrerequisitePrFor,
    buildPrerequisitePrDispatchArgs,
    prerequisitePrAdmissionRefusal,
    reportSubstituteStandDownReason,
    ciFailurePromptEvidence,
    verifiedReviewFindingsForFix,
    proofRepairStageablePaths,
    proofRepairPromptLines,
    lastCommitRefusalPromptLines,
    fixLearnedArmsFor,
    fixWorkerEndedBySignal,
    censusSnapshotForCheck,
    derivedFixCommit,
    isRetriggerShapedCommit,
    scopeAmendmentFromFixReport,
    undeclaredPathsLedgerFields,
    fixRoundLandingFields,
    requeueActionsJobOutcome,
    dispatchProofAmendmentWrite,
    deriveChangesetClaimUpdate,
  } = fixCommandHelpers(host);
  const roundRows: Record<string, unknown>[] = [];
  const deps = { ...opts.deps, log: (step: string, extra?: Record<string, unknown>) => {
    roundRows.push({ ...extra, task_id: opts.taskId, step });
    opts.deps.log(step, extra);
  } };
  // W1-T7096: production call sites opt into the LLM judge. A caller that wires none (a test
  // fixture) keeps the former bounds as an explicit, judge-shaped stand-in — never a silent LLM spawn.
  const progressJudge: FixProgressJudge = deps.fixProgressJudge ?? (opts.useProductionProgressJudge
    ? productionFixProgressJudge({ cwd: opts.worktreePath, settingsFile: opts.settingsFile })
    : formerBoundStandIn(() => standInEscalates, (step, extra) => deps.log(step, extra), deps.say));
  // W1-T7096: the stand-in reproduces the pre-judge rung EXACTLY — it rules "escalate" at each site where the
  // former fixed rung stopped (a reached bound, an unchanged tree, a ci-log or review false-block) and "continue"
  // everywhere else. A wired judge sees the same site reason as its parked reason and decides for itself.
  let standInEscalates = false;
  const retriggerCap = opts.retriggerCap ?? DEFAULT_FIX_RETRIGGER_CAP;
  let judgedStop: { loop: string; reason: string; judged?: boolean } | undefined;
  let consultedThisRound = false;
  let progressApproach = opts.progressApproach;
  let progressRoundReason: string | undefined;
  const progressConstraint = () => [opts.constraint, progressApproach && `Progress judge approach: ${progressApproach}`].filter(Boolean).join("\n\n") || undefined;
  // W1-T3579: computed ONCE, from the live task this rung was dispatched against — never
  // recomputed per round (a task's own contract cannot change mid-rung; only a FRESH `runFixRung`
  // built by the next sweep, after a plan amendment, would ever see a different one). Threaded
  // into both the pre-strike probe's key and the false-block producer below, so the two can never
  // disagree about "current".
  const currentContractRevision = taskContractRevision(opts.task);
  const currentSemanticRevision = taskSemanticRevision(opts.task);
  let progressReviewInputDigest = opts.progressReviewInputDigest;
  const admitFixTests = !(opts.task.files?.length && opts.task.files.every(isInPlanScope));
  // W1-T3166 — THE CALL W1-T349's judge never had: zero production callers, an empty fleet-notice
  // queue, no ledger step. The ten fix-rung sites below are the NEEDS ME board's largest class.
  // Built here, not per callsite, so a construction failure surfaces once at rung entry.
  const escalationJudge =
    opts.escalationJudge ??
    realEscalationJudge({
      mounts: loadMounts(mountsPath(repoRoot)),
      cwd: opts.worktreePath,
      settingsFile: opts.settingsFile,
    });
  let review = opts.initialReview;
  let reconstructedReviewChecked = false;
  const proofDiscriminationStillNeedsRepair = () =>
    opts.proofDiscrimination !== undefined &&
    review.capped === true &&
    proofDiscriminationEvidenceFromCriteria(review.criteria) !== undefined;
  let strikes = 0;
  let retriggers = 0;
  const branchClaimLost = (): FixRungOutcome | undefined => {
    const reason = deps.branchClaim?.reacquire();
    if (reason === undefined) return undefined;
    deps.log("fix.stood_down", { site: "rung.branch_claim", strike: strikes, reason });
    deps.say(`fix rung: standing down — ${reason}`);
    return { outcome: "stood_down", review, strikes, retriggers, reason, standDownReason: reason };
  };
  const ciHandoff = (ci: CiGateOutcome | "green" | "red" | "timeout"): FixRungOutcome | undefined => {
    if (typeof ci === "string" || ci.state !== "freshness_handoff") return undefined;
    deps.log("fix.ci_not_green", { strike: strikes, ci: ci.state, sha: ci.sha });
    const reason = ci.recycle ? "recycle_yield" : "freshness_yield";
    // W1-T5957: the round's one outcome row; the next sweep re-derives this PR.
    deps.log("fix.stood_down", { site: "rung.ci_handoff", strike: strikes, outcome: "handed_off", owner: "sweep",
      trigger: ci.recycle ? "recycle" : ci.trigger ?? "freshness", reason, sha: ci.sha });
    return { outcome: "handed_off", review, strikes, retriggers, reason };
  };
  let sessionToResume: string | undefined = opts.initialSessionId;
  let previousForResume: Pick<WorkerResult, "provider" | "text" | "blocks"> = {
    provider: opts.initialSessionProvider, text: "", blocks: [],
  };
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
  // W1-T2804: the head sha THIS rung's most recent gate read judged. Seeded from the dispatching
  // sweep's own resolved head so round 1 is pinned too, then re-pinned by every gate read. It is
  // never independently resolved here — a second read is a second chance to skew.
  let currentPinnedSha: string | undefined = opts.ciEvidenceDisagreement?.sha;
  // W1-T2551: bounds the generator-fix short-circuit (site `rung.generator_fix`, below) to a
  // SMALL number of attempts per invocation — every attempt already re-verifies the regenerated
  // output against its OWN `:check` before committing anything, but this caps how many rounds a
  // persistent CI/local environment mismatch (never observed, guarded anyway) can spend spinning
  // this rung without ever reaching a worker that could actually diagnose it.
  let generatorFixAttempts = 0;
  const GENERATOR_FIX_ATTEMPT_CAP = 2;
  // W1-T1279: every check name EVER observed red across this rung's strikes — the trajectory
  // input for the exhaustion escalation's own detail text (renderCiTrajectoryLine, above).
  // Seeded from round 1's evidence and re-unioned after every refresh below (never cleared), so a
  // name that drops out later — because some earlier strike repaired it — still shows up here
  // even though `currentCiFailures` itself has already moved on.
  const everRedCiCheckNames = new Set<string>((opts.ciFailures ?? []).map((f) => f.name));
  // W1-T106 (the #170 DIRTY strand): mirrors `noReviewYet`/`currentCiFailures`
  // for the merge-conflict mode — a SEPARATE variable (never folded into
  // `noReviewYet`) because a dirty PR carries no ci-log evidence at all; the
  // two shapes are mutually exclusive by construction (see FixDispatchEvidence).
  // Cleared the moment CI can run at all (see below) — the conflict is
  // resolved enough for GitHub to compute the merge ref, so every later
  // strike reverts to whichever mode its now-computable state derives.
  let currentMergeConflict = opts.mergeConflict;
  const consecutiveMergeRefusalReasons: string[] = [];
  /** #10787: ends merge-conflict mode once the merge is proven done, so the next round derives its red. */
  const leaveMergeMode = (site: string, headSha: string | undefined): void => {
    if (currentMergeConflict === undefined) return;
    deps.log("fix.merge_mode_cleared", { site, strike: strikes, head_sha: headSha,
      conflicted_files: conflictedFilePaths(currentMergeConflict), current_red: (currentCiFailures ?? []).map((f) => f.name) });
    currentMergeConflict = undefined;
    consecutiveMergeRefusalReasons.length = 0;
  };
  // W1-T296: the head THIS INVOCATION's own most recent strike produced —
  // `undefined` until the first round's push+review completes below, which
  // is exactly the "first round has no prior head" contract
  // {@link branchAuthorshipStandDownReason} documents: round 1 never reads
  // as foreign no matter what the live head is.
  let rungOwnHeadSha: string | undefined;
  // W1-T2293: the PREVIOUS round's own `reportSubstituteCause` (below, where `deps.runReview` is
  // called) — `undefined` for `opts.initialReview` (always a real body fetch, computed outside
  // this rung entirely) and for every round that never reached a real re-review at all. Read at
  // the TOP of the NEXT round's pre-strike gate by `reportSubstituteStandDownReason`, so a review
  // this rung itself judged off an unread body never dispatches another strike against it.
  let lastReportSubstituteCause: import("../../lib/review.js").ReportSubstituteCause | undefined;
  // W1-T1284: the (gate identity, worktree snapshot) pair recorded the last time this
  // invocation's pre-strike gate ran — `undefined` on the first round (nothing recorded yet;
  // see {@link unchangedTreeStandDownReason}'s own "first round" contract) and whenever
  // `deps.captureWorktreeSnapshot` is not wired at all.
  let lastGateSnapshot: { gateKey: string; snapshot: WorktreeSnapshot } | undefined;
  // W1-T1227: the changed-file list as it stood BEFORE this invocation's first strike —
  // {@link fixRungScopeStandDownReason}'s baseline, so a path already out of scope before this
  // rung ever ran (tolerated by `scopeGuardOutOfScopeFiles`'s push-and-flag disposition on the
  // implement path) is never re-flagged as something the RUNG added. An omitted reader skips
  // the check; an unreadable diff stands down before dispatch (W1-T4074).
  let baselineDiffFiles: string[] | undefined;
  if (deps.fetchPrDiffFiles) {
    try {
      baselineDiffFiles = await deps.fetchPrDiffFiles(opts.prUrl);
    } catch (error) {
      const reason = `PR diff unreadable — no surface to stage can be verified: ${String(error)}`;
      const site = (opts.task.files ?? []).length === 0 ? "rung.empty_commit_surface" : "rung.pr_diff_unreadable";
      deps.log("fix.stood_down", { site, strike: strikes + 1, reason });
      deps.say(`fix rung: ${reason} — standing down before spending a worker round`);
      return { outcome: "stood_down", review, strikes, retriggers, reason, standDownReason: reason };
    }
  }
  // W1-T1278 (condition B): THIS rung's own PR number, parsed once — `undefined` when `prUrl`
  // does not parse, in which case the pre-strike merge-conflict check below is skipped every
  // round (never a guessed number).
  const prNumber = host.prNumberFromRef(opts.prUrl);
  const amendScope = async (paths: string[], changedPaths: string[], headSha: string, saveWork = false): Promise<ScopeAmendmentOutcome> => {
    let outcome: ScopeAmendmentOutcome;
    try {
      const body = await (deps.fetchPrBody ?? host.fetchPrBodyViaGh)(opts.prUrl);
      const trailers = [...body.matchAll(/^Remudero-Task:[ \t]*(\S+)[ \t]*$/gm)];
      const ports = deps.scopeAmendmentWritePorts ?? host.buildProofAmendmentWritePorts({
        taskId: opts.taskId, worktreePath: opts.worktreePath, config: opts.config,
        owner: opts.reviewBase.owner, repo: opts.reviewBase.repo, prNumber: prNumber!,
        ledgerLinesNow: (deps.ledgerLines ?? (() => readLedgerLines(deps.ledgerPath)))(), log: deps.log,
        gitOps: host.buildProofAmendmentGitOps(), amendmentKind: "scope_amendment",
      }, deps.scopeAmendmentPortsIo);
      outcome = requestScopeAmendment({ taskId: opts.taskId, prNumber: prNumber!, prUrl: opts.prUrl,
        headSha, paths, changedPaths, trailerTaskId: trailers.length === 1 ? trailers[0][1] : undefined,
        headRef: opts.branch }, ports);
    } catch (error) {
      outcome = { kind: "refused", reason: "scope-amendment-error", detail: String(error) };
    }
    let recovery: Record<string, unknown> = {};
    if (saveWork && (outcome.kind === "created" || outcome.kind === "resumed")) {
      try {
        recovery = { recovery_status: "saved",
          recovery_path: await saveScopeAmendmentWork(scopeWork(paths, outcome.amendmentNumber)) };
      } catch (error) {
        const reason = String(error);
        recovery = { recovery_status: "unavailable", recovery_reason: reason };
      }
    }
    if (outcome.kind !== "amendment_merged") deps.log("fix.scope_amendment", { outcome: outcome.kind, ...outcome, paths, head_sha: headSha,
      pr_number: prNumber, amendment_url: "amendmentUrl" in outcome ? outcome.amendmentUrl : undefined, ...recovery });
    return outcome;
  };
  const scopeWork = (paths: string[], amendmentNumber: number) => ({ root: opts.config.root,
    worktreePath: opts.worktreePath, taskId: opts.taskId, prNumber: prNumber!, amendmentNumber, paths });
  // W1-T2671: at most one base-gap read/update attempt per invocation. A successful update ends
  // this invocation because GitHub's update-branch endpoint is asynchronous and the current
  // worktree is now stale; the next level-triggered sweep reconstructs both CI and the checkout
  // at the new head. A failed/indeterminate read falls through to the ordinary fix rung.
  let baseRefreshChecked = false;
  // W1-T4693: the last census refusal of this rung's own push, and what a round does when its push did not
  // land. A census refusal becomes the next strike's ci-log evidence, as W1-T4656 feeds its first strike;
  // any other failure ends the rung. Neither waits on CI for a head that never landed.
  let pushRefusal: CensusPushRefusal | undefined;
  const censusRefusalIsCurrent = () => pushRefusal !== undefined && noReviewYet && (currentCiFailures ?? []).some((f) => f.name === host.CENSUS_PUSH_CHECK);
  const offeredCensusBaselines = () => (censusRefusalIsCurrent() ? pushRefusal!.offeredBaselines : []);
  let roundPushFailure: Extract<FixRoundLanding, { landed: false }> | undefined;
  let roundPushReceipt: FixRoundPushReceipt | undefined;
  const landRoundPush = async (push: () => unknown, headSha: string | undefined, site: string): Promise<FixRungOutcome | "refused" | undefined> => {
    roundPushFailure = undefined;
    roundPushReceipt = undefined;
    try {
      const pushed = await push();
      if (isFixRoundPushReceipt(pushed)) roundPushReceipt = pushed;
      return undefined;
    } catch (e) {
      if (!(e instanceof host.FixRoundPushError)) throw e;
      const text = (e.refusal?.text ?? e.detail).slice(0, 2000);
      roundPushFailure = { landed: false, outcome: e.refusal ? "refused" : "failed", cause: e.pushCause, reason: text.slice(0, 500) };
      if (e.refusal) {
        deps.log("fix.push_refused", { site, strike: strikes, censuses: e.refusal.censuses, refusal: text, head_sha: headSha, pr_head_sha: review.headSha });
        deps.say(`fix rung: strike ${strikes}/${opts.strikeCap} push REFUSED by the pre-push census (${e.refusal.censuses.join(", ")}) — the next strike gets the refusal`);
        pushRefusal = e.refusal;
        currentCiFailures = [{ name: host.CENSUS_PUSH_CHECK, logTail: e.refusal.text }];
        everRedCiCheckNames.add(host.CENSUS_PUSH_CHECK);
        noReviewYet = true;
        currentMergeConflict = undefined;
        // The local head now carries an unpushed commit; merging base into the remote would strand it.
        baseRefreshChecked = true;
        return "refused";
      }
      deps.log("fix.push_failed", { site, strike: strikes, cause: e.pushCause, error: text, head_sha: headSha, pr_head_sha: review.headSha });
      const reason = `fix round push failed (${e.pushCause})`;
      deps.say(`fix rung: ${reason} — standing down without waiting on CI for the old head`);
      return { outcome: "stood_down", review, strikes, retriggers, reason, standDownReason: `${reason}: ${text}` };
    }
  };
  const lsRemoteBranchHead = async (wt: string, branch: string) =>
    (await hostWorktreeGitAsync(wt, ["ls-remote", "origin", `refs/heads/${branch}`])).split(/\s/)[0] || undefined;
  const roundLanding = async (committed: string | undefined): Promise<FixRoundLanding> => {
    const failure = roundPushFailure;
    const receipt = roundPushReceipt;
    roundPushFailure = roundPushReceipt = undefined;
    if (failure) return failure;
    const readRemoteBranchHead = deps.readRemoteBranchHead ?? (receipt ? lsRemoteBranchHead : undefined);
    if (!readRemoteBranchHead) return { landed: true }; // a push double that names no head never reached a remote to read
    const headSha = receipt?.fixRoundPushedHead ?? committed;
    const read = await Promise.resolve().then(() => readRemoteBranchHead(opts.worktreePath, opts.branch)).then(
      (head) => ({ head, unreadable: undefined }), (error: unknown) => ({ head: undefined, unreadable: String((error as Error)?.message ?? error).slice(0, 500) }));
    const remoteHead = read.head;
    const unreadable = read.unreadable;
    const seen = remoteHead === undefined ? {} : { remoteHead };
    if (headSha !== undefined && remoteHead === headSha) return { landed: true, remoteHead };
    if (unreadable !== undefined) return { landed: false, outcome: "remote_unreadable", reason: unreadable };
    return { landed: false, outcome: "not_on_remote", ...seen,
      reason: `refs/heads/${opts.branch} holds ${remoteHead ?? "<absent>"}, not the round's commit ${headSha ?? "<unread>"}` };
  };

  // W1-T7096: every completed round, including retriggers, returns to the progress judge.
  const judgeIsStandIn = deps.fixProgressJudge === undefined && !opts.useProductionProgressJudge;
  // `forJudge`: whether a wired judge is shown the site's reason as its parked reason. A reached bound or an
  // unchanged tree is already in the judge's own signals; a false-block finding and merge refusals are not.
  const consultAtSite = async (parkedReason: string, forJudge = true) => {
    const persisted = (deps.ledgerLines ?? (() => readLedgerLines(deps.ledgerPath)))();
    const input = buildFixProgressInput({ taskId: opts.taskId, prNumber,
      headSha: review.headSha, currentRed: currentMergeConflict !== undefined
        ? (conflictedFilePaths(currentMergeConflict) ?? []).map(path => `conflict:${path}`)
        : noReviewYet ? (currentCiFailures ?? []).map(f => f.name)
        : review.criteria.filter(c => !c.met).map(c => `review:${c.claim}`),
      ledger: [...persisted.filter(row => !roundRows.some(local => row.step === local.step &&
        row.round_id === local.round_id && row.head_sha === local.head_sha && row.strike === local.strike)), ...roundRows],
      operatorAnswer: opts.constraint, formerCeiling: opts.strikeCap, parkedReason: forJudge ? parkedReason : undefined });
    standInEscalates = true;
    try {
      const { decision, receipt } = await resolveFixProgress(input, persisted,
        { judge: progressJudge, reviewInputDigest: progressReviewInputDigest, contractRevision: currentContractRevision });
      deps.log(receipt.step, { pr_number: prNumber, head_sha: review.headSha, site: "rung.parked",
        parked_reason: parkedReason, former_ceiling: input.formerCeiling,
        round_count: input.rounds.length, signals: input.signals, ...decision, ...receipt });
      return decision;
    } finally {
      standInEscalates = false;
    }
  };
  // `applies-to: fix` skills, on the implement lane's tree, budget and seeded per-run withholding, so a
  // fix-lane effectiveness report has a randomized control. One assignment per run: every strike agrees.
  const fixSkillSelection = observeSkillSelection(
    loadInjectableSkills(deps.approvedSkillsDir ?? join(repoRoot, ".claude", "skills")),
    SKILL_FIX_TASK_TYPE,
    DEFAULT_KNOWLEDGE_BUDGET_CHARS,
    opts.task.files,
    (skillName) => skillWithheldForRun(opts.runId, skillName),
  );
  let fixSkillSelectionLogged = false;
  while (review.state !== "success" || proofDiscriminationStillNeedsRepair()) {
    consultedThisRound = false;
    // A wired judge rules every round itself (below); only the stand-in stops at the former bounds here.
    if (judgeIsStandIn && (strikes >= opts.strikeCap || retriggers >= retriggerCap || consecutiveMergeRefusalReasons.length >= 2)) {
      const bound = consecutiveMergeRefusalReasons.length >= 2
        ? `Consecutive merge refusals:\n${consecutiveMergeRefusalReasons.join("\n")}`
        : retriggers >= retriggerCap && strikes < opts.strikeCap
        ? `retrigger-shaped rounds reached the former retrigger bound (${retriggers}/${retriggerCap})`
        : `fix rounds reached the former ceiling (${strikes}/${opts.strikeCap})`;
      const stop = await consultAtSite(bound, consecutiveMergeRefusalReasons.length >= 2);
      if (stop.verdict === "unavailable") return { outcome: "handed_off", review, strikes, retriggers, reason: stop.reason };
      if (stop.verdict === "escalate") { judgedStop = { loop: stop.loop, reason: stop.reason, judged: !judgeIsStandIn }; break; }
      consultedThisRound = true;
      if (stop.verdict === "change-approach") progressApproach = stop.approach;
    }
    const claimLost = branchClaimLost();
    if (claimLost) return claimLost;
    // W1-T177 SITE (i) — TERMINAL-STATE CHECK before `strikes++`: the ONLY
    // point that stops a strike being SPENT on a PR that went terminal
    // (merged/closed) since the previous round. Read FRESH every round —
    // never the caller's snapshot. W1-T296 composes a SECOND reason source
    // into this SAME check (never a parallel early-return): a live head
    // this invocation did not itself produce, which escalates rather than
    // ledgering silently — see the `foreignHead` branch below. W1-T1278 composes TWO more —
    // condition A (a red required check's later attempt already in flight) and condition B (a
    // dirty merge state) — see `fixRungStandDownReason`'s own doc for both. W1-T1284 composes a
    // FOURTH — the worktree byte-identical to the last time THIS SAME gate was about to be spent
    // against — see `unchangedTreeStandDownReason`'s own doc.
    //
    // `gateKey` mirrors the SAME mode precedence `evidence` below derives from (merge-conflict,
    // then ci-log, then review) — content only, never the base and never the check rollup (Q2's
    // own constraint) — so a rung that fixed check A and moved on to a newly-red check B, or one
    // whose base moved and flipped WHICH check is red, is never told "nothing changed".
    const gateKey =
      currentMergeConflict !== undefined
        ? `merge-conflict:${JSON.stringify((conflictedFilePaths(currentMergeConflict) ?? []).sort())}`
        : noReviewYet
        ? `ci:${(currentCiFailures ?? []).map((f) => f.name).slice().sort().join(",")}`
        : `review:${visibleCriteria(review.criteria.filter((c) => !c.met))
            .map((c) => c.claim)
            .slice()
            .sort()
            .join(",")}`;
    let currentTreeSnapshot: WorktreeSnapshot | undefined;
    if (deps.captureWorktreeSnapshot) {
      try {
        currentTreeSnapshot = await deps.captureWorktreeSnapshot(opts.worktreePath);
      } catch (error) {
        currentTreeSnapshot = undefined; // fail open — an unreadable capture never manufactures a stand-down
        deps.log("fix.gate_read_error", { site: "rung.strike", strike: strikes + 1, read: "worktree_snapshot", error: String(error) });
      }
    }
    const registeredWorktrees = opts.birthWorktreeSnapshot && deps.readRegisteredWorktrees
        ? await Promise.resolve().then(deps.readRegisteredWorktrees).catch((error: unknown): undefined => {
          deps.log("fix.gate_read_error", { site: "rung.strike", strike: strikes + 1, read: "registered_worktrees", error: String(error) });
          return undefined;
        })
        : undefined;
    let preStrikeStandDown = await fixRungStandDownReason(
      deps.readLiveState,
      opts.prUrl,
      "rung.strike",
      deps.log,
      deps.readLiveHead ? { readLiveHead: deps.readLiveHead, rungOwnHeadSha } : undefined,
      noReviewYet && currentCiFailures && currentCiFailures.length > 0 && deps.readCiRollup
        ? { redNames: currentCiFailures.map((f) => f.name), readRollup: deps.readCiRollup }
        : undefined,
      // Skipped whenever `currentMergeConflict` is already set — that mode already owns a dirty
      // read correctly (design note iv); this check exists for every OTHER mode, where a dirty
      // read would otherwise go unnoticed.
      currentMergeConflict === undefined && deps.readMergeFacts && prNumber !== undefined
        ? { prNumber, readMergeFacts: deps.readMergeFacts }
        : undefined,
      deps.captureWorktreeSnapshot && consecutiveMergeRefusalReasons.length === 0 ? { gateKey, previousFailure: lastGateSnapshot, currentSnapshot: currentTreeSnapshot } : undefined,
      opts.birthWorktreeSnapshot ? { round: strikes + retriggers + 1, branch: opts.branch, currentWorktreePath: opts.worktreePath, birthSnapshot: opts.birthWorktreeSnapshot, currentSnapshot: currentTreeSnapshot, registeredWorktrees } : undefined,
      // W1-T2799: the SIXTH source — has a human already been asked about this exact state? The
      // key is the escalation the false-block escape below would file if this strike changed
      // nothing, assembled through the SAME `EscalationDedupKey` shape `escalate()` itself is
      // keyed on, so probe and producer can never disagree about which issue is the duplicate.
      // `summary` carries `opts.prUrl` because the dedup key's PR dimension is scraped out of the
      // summary/detail TEXT (`extractPrRef`), never passed as a field. A gateway with no
      // `listOpen` makes `findDuplicateEscalation` return `undefined` for every key, so this site
      // behaves exactly as it did before this task — every strike still spends.
      deps.issues.listOpen
        ? {
            headSha: review.headSha,
            key: {
              class: "BLOCKED" as const,
              taskId: opts.taskId,
              summary: `review false-block — ${opts.prUrl}`,
              detail: "",
              headSha: review.headSha,
              cause: escalationCause(currentMergeConflict !== undefined, noReviewYet),
              // W1-T3579: the 4th dedup dimension — see this function's own `openEscalation` doc.
              contractRevision: currentContractRevision,
            },
            find: (key: EscalationDedupKey) => findDuplicateEscalation(key, { issues: deps.issues }),
            current: { conflictEvidenceCaptured: hasCapturedMergeConflictEvidence(currentMergeConflict), baseSha: opts.baseSha },
            resolve: (candidate: OpenIssue, clearedCause: string) =>
              resolveClearedEscalation(deps.issues, deps.log, opts.taskId, candidate.url, clearedCause),
          }
        : undefined,
    );
    // W1-T1284: recorded for the NEXT round's comparison regardless of what this round decides —
    // a return below (any stand-down) means there IS no next round, so updating here first is
    // inert on every exit path and correct on the one path that loops back to the top. An
    // unreadable capture this round clears the record to `undefined` — exactly the documented
    // "prior capture was unreadable" contract {@link unchangedTreeStandDownReason} reads.
    if (deps.captureWorktreeSnapshot) {
      lastGateSnapshot = currentTreeSnapshot ? { gateKey, snapshot: currentTreeSnapshot } : undefined;
    }
    // W1-T7096: an unchanged tree is a loop SIGNAL — the progress judge decides whether it stops the rung.
    // A wired judge reads the unchanged tree from its own signals; only the stand-in stands down on it here.
    if (preStrikeStandDown?.unchangedTree) {
      if (judgeIsStandIn) {
        const stop = await consultAtSite(preStrikeStandDown.reason, false);
        if (stop.verdict === "unavailable") return { outcome: "handed_off", review, strikes, retriggers, reason: stop.reason };
        if (stop.verdict !== "escalate") preStrikeStandDown = undefined;
      } else {
        preStrikeStandDown = undefined;
      }
    }
    if (preStrikeStandDown) {
      const foreignTree = preStrikeStandDown.foreignTree;
      if (foreignTree) {
        deps.log("rung.foreign_tree", { site: "rung.strike", strike: strikes + 1, branch: opts.branch, reason: foreignTree.reason, porcelain_paths: foreignTree.porcelainPaths, diffstat: foreignTree.diffstat, other_worktrees: foreignTree.otherWorktrees });
        const detail = `The blocked_review FIX RUNG (W1-T76, W1-T2652) observed local worktree content on ${opts.branch} before spending strike ${strikes + 1}: ${foreignTree.reason}. The rung did not observe an author for this content and will not reset, stash, clean, commit or push it. Observed porcelain paths: ${JSON.stringify(foreignTree.porcelainPaths)}. Observed diffstat: ${JSON.stringify(foreignTree.diffstat)}. Other registered worktrees on this branch: ${JSON.stringify(foreignTree.otherWorktrees)}.`;
        const issueUrl = await escalateWithJudge(
          { class: "BLOCKED", taskId: opts.taskId, runId: opts.runId, headSha: review.headSha, cause: escalationCause(currentMergeConflict !== undefined, noReviewYet), summary: `fix rung standing down — foreign worktree content before round 1 — ${opts.prUrl}`, detail, options: [{ label: "discard", detail: "remove the foreign local content, then re-run the fix rung against a clean materialized worktree." }, { label: "adopt", detail: "confirm this local content is intentional and should be preserved before resuming the fix rung." }], recommendation: "discard" },
          { issues: deps.escalationIssues ?? deps.issues, ledgerPath: deps.ledgerPath, runId: opts.runId, judge: escalationJudge },
        );
        deps.log("fix.stood_down", { site: "rung.foreign_tree", strike: strikes + 1, reason: preStrikeStandDown.reason, issue_url: issueUrl });
        deps.say(`fix rung: standing down before strike ${strikes + 1} — ${preStrikeStandDown.reason} — escalated: ${issueUrl}`);
        return { outcome: "stood_down", review, strikes, retriggers, reason: preStrikeStandDown.reason, standDownReason: preStrikeStandDown.reason, issueUrl };
      }
      if (preStrikeStandDown.foreignHead) {
        // W1-T296: a human or a sibling session appears to be actively
        // editing this branch — unlike the terminal-state reason above,
        // this carries an operator-decidable question (yield, or confirm
        // the takeover), so it escalates rather than ledgering silently.
        // Distinct disposition from W1-T196's unattributable-pr stand-down,
        // which ledgers because THAT state carries no decidable question.
        const { headSha: foreignHeadSha, author: foreignAuthor } = preStrikeStandDown.foreignHead;
        const issueUrl = await escalateWithJudge(
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
          { issues: deps.escalationIssues ?? deps.issues, ledgerPath: deps.ledgerPath, runId: opts.runId, judge: escalationJudge },
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
        return { outcome: "stood_down", review, strikes, retriggers, reason: preStrikeStandDown.reason, standDownReason: preStrikeStandDown.reason, issueUrl };
      }
      deps.log("fix.stood_down", { site: "rung.strike", strike: strikes + 1, reason: preStrikeStandDown.reason });
      deps.say(`fix rung: standing down before strike ${strikes + 1} — ${preStrikeStandDown.reason}`);
      return { outcome: "stood_down", review, strikes, retriggers, reason: preStrikeStandDown.reason, standDownReason: preStrikeStandDown.reason };
    }

    // W1-T10029: revalidate concrete reconstructed failed proofs before the first dispatch on
    // this head. A missing proof cannot be re-executed, and an earlier dispatch owns the
    // progress decision for its head; neither is a fresh no-op prevention opportunity.
    if (!reconstructedReviewChecked && currentMergeConflict === undefined && !noReviewYet &&
      review.reviewerOutcome === "sweep-reconstructed" &&
      review.criteria.some((criterion) => !criterion.met && criterion.proof_exec === "executed_fail" && criterion.proof.trim() !== "") &&
      !(deps.ledgerLines ?? (() => readLedgerLines(deps.ledgerPath)))().some((row) =>
        row.step === "fix.dispatch" && row.task_id === opts.taskId && row.head_sha === review.headSha)) {
      reconstructedReviewChecked = true;
      try {
        const body = await (deps.fetchPrBody ?? host.fetchPrBodyViaGh)(opts.prUrl);
        const fresh = await deps.runReview({
          ...opts.reviewBase, prUrl: opts.prUrl, task: opts.task, report: body,
          reportIsSubstitute: false, reviewInputBody: body, settingsFile: opts.settingsFile,
          config: opts.config, budgetUsd: opts.budgetUsd, log: deps.log, say: deps.say,
          account: deps.account, reviewerClockBoundMs: opts.reviewerClockBoundMs,
          workerTelemetry: opts.workerTelemetry, reviewerCodeFreshness: opts.reviewerCodeFreshness,
          ledgerPath: deps.ledgerPath, runId: opts.runId, openTaskIds: opts.openTaskIds,
        });
        deps.log("fix.pre_dispatch_review", { head_sha: fresh.headSha, prior_head_sha: review.headSha,
          state: fresh.state, verdict_withheld: fresh.verdictWithheld });
        if (fresh.verdictWithheld || fresh.headSha !== review.headSha) {
          const reason = fresh.verdictWithheld ?? "PR head moved during pre-dispatch review";
          deps.log("fix.stood_down", { site: "rung.pre_dispatch_review", reason, head_sha: fresh.headSha });
          return { outcome: "stood_down", review: fresh, strikes, retriggers, reason, standDownReason: reason };
        }
        review = fresh;
        progressReviewInputDigest = reviewInputDigest(fresh.headSha, body);
        if (fresh.state === "success") continue;
      } catch (error) {
        deps.log("fix.pre_dispatch_review_error", { head_sha: review.headSha, error: String(error) });
      }
    }

    // W1-T2671 SITE — BASE-GAP REFRESH, BEFORE `strikes++` and before every deterministic/worker
    // repair below. This is deliberately restricted to a ci-log round with a non-empty failure
    // set: only that shape supplies the failing test or diff-coverage source path needed to prove
    // that the base changed the same file. `decideRedBaseRefresh` requires BOTH a positive behind
    // count and an exact repository-path/suffix match; current branches and unrelated base
    // movement fall through.
    //
    // A successful update returns immediately with ZERO strikes. GitHub documents this endpoint
    // as asynchronous (202) and as MERGING base HEAD into the PR branch, so polling CI immediately
    // could still observe the OLD red head, while continuing in this invocation would hand a
    // stale checkout to the worker. The next sweep is the safe continuation: if the merge clears
    // CI, normal review proceeds; if CI remains red, `behindBy` is then zero and this same gate
    // falls through to the ordinary strike. That is one level-triggered flow, not credit for a fix.
    if (
      !baseRefreshChecked &&
      currentMergeConflict === undefined &&
      noReviewYet &&
      currentCiFailures !== undefined &&
      currentCiFailures.length > 0 &&
      prNumber !== undefined &&
      deps.readRedBaseRefreshFacts &&
      deps.updateBranch
    ) {
      baseRefreshChecked = true;
      try {
        const facts = await deps.readRedBaseRefreshFacts(prNumber);
        const decision = decideRedBaseRefresh(currentCiFailures, facts);
        deps.log("fix.base_refresh_checked", {
          strike: strikes + 1,
          pr_number: prNumber,
          behind_by: decision.behindBy,
          failing_test_files: decision.failingTestFiles,
          failing_source_files: decision.failingSourceFiles,
          matching_base_files: decision.matchingBaseFiles,
          // W1-T7445: uncovered lines no refresh can cover; absent when added-line evidence was unreadable.
          ...(decision.prAddedUncoveredLines !== undefined
            ? { pr_added_uncovered_lines: decision.prAddedUncoveredLines }
            : {}),
          refresh: decision.refresh,
        });
        // W1-T8396: an exact-path match says main touched the red's files, not that merging main clears
        // the red — a failing test file that still fails on a trial merge is the PR's own. This arm's
        // matched paths are themselves counted, so rule 3's path test never refuses here; the history
        // read below still makes a repeat on the same red need a trial merge that clears it.
        const refreshTestFiles = baseReproductionFiles(currentCiFailures);
        const refreshChecks = [...new Set(currentCiFailures.map((failure) => failure.name))];
        let refreshMainSha: string | undefined;
        const probeMerge = deps.reproduceFailingTestsOnMerge;
        if (decision.refresh && refreshTestFiles.length > 0 && probeMerge) {
          // An unreadable main tip leaves the probe unrunnable, which keeps only a first refresh of this red.
          refreshMainSha = await Promise.resolve(deps.readMainTip ? deps.readMainTip() : host.mainTipViaGit(opts.worktreePath)).then(
            (sha) => sha, (error: unknown) => { deps.log("refresh.clearance.main_tip_unreadable", { error: boundedBaseProbeReason(error) }); return undefined; });
        }
        const clearance = decision.refresh ? await assessRefreshClearance({
          failingTestFiles: refreshTestFiles,
          reach: mainPathsReachingRed({ failingTestFiles: refreshTestFiles, mainChangedFiles: facts.baseChangedFiles, closure: undefined,
            isHarnessPath: isCiHarnessPath, matchedPaths: decision.matchingBaseFiles }),
          priorRefresh: refreshedOnSameRed(refreshRecordsFromLedger((deps.ledgerLines ?? (() => readLedgerLines(deps.ledgerPath)))()),
            prNumber, refreshChecks, refreshTestFiles),
        }, probeMerge && refreshMainSha !== undefined
          ? () => probeMerge({ prNumber, headSha: review.headSha } as OpenPrView, refreshTestFiles, refreshMainSha!) : undefined)
          : undefined;
        if (clearance !== undefined) {
          deps.log(REFRESH_CLEARANCE_STEP, refreshClearanceFields({ arm: "fix-rung", pr_number: prNumber, head_sha: review.headSha,
            ...(refreshMainSha === undefined ? {} : { main_sha: refreshMainSha }), checks: refreshChecks, test_files: refreshTestFiles }, clearance));
        }
        if (decision.refresh && clearance?.refresh !== false) {
          // W1-T7735: a repair-driven refresh keeps its own trigger but still writes its decision row.
          deps.log(REFRESH_DECIDED_STEP, forcedRefreshFields({ prNumber, headSha: review.headSha, forcedBy: "fix-base-refresh",
            nowMs: systemClock.now() }));
          const updated = await deps.updateBranch(prNumber);
          if (updated.ok) {
            const reason =
              `base refresh requested before strike ${strikes + 1}: head was ${decision.behindBy} commit(s) behind ` +
              `and base changed ${decision.matchingBaseFiles.join(", ")}; GitHub is merging base into the branch`;
            deps.log("fix.base_refreshed", {
              strike: strikes + 1,
              pr_number: prNumber,
              // W1-T8396: the red this refresh was taken on, so no arm repeats it on the head it makes.
              head_sha: review.headSha,
              red_checks: refreshChecks,
              test_files: refreshTestFiles,
              behind_by: decision.behindBy,
              matching_base_files: decision.matchingBaseFiles,
              method: "merge",
              reason,
            });
            deps.say(`fix rung: BASE REFRESH requested with no strike spent — ${reason}: ${opts.prUrl}`);
            return { outcome: "base_refreshed", review, strikes, retriggers, reason };
          }
          deps.log("fix.base_refresh_failed", {
            strike: strikes + 1,
            pr_number: prNumber,
            behind_by: decision.behindBy,
            matching_base_files: decision.matchingBaseFiles,
            error: updated.error ?? "no error reported",
          });
        }
      } catch (e) {
        deps.log("fix.base_refresh_read_error", {
          strike: strikes + 1,
          pr_number: prNumber,
          error: String((e as Error)?.message ?? e),
        });
      }
    }

    if (!consultedThisRound && (roundRows.some(row => row.step === "fix.dispatch" || row.step === "fix.retrigger") || !opts.progressDecision)) {
      const persisted = (deps.ledgerLines ?? (() => readLedgerLines(deps.ledgerPath)))();
      const input = buildFixProgressInput({ taskId: opts.taskId, prNumber,
        headSha: review.headSha,
        strikesSpent: Math.max(strikes, priorStrikesFor([...persisted, ...roundRows], opts.taskId,
          strikeRegimeForDispatch(review.criteria), review.headSha)),
        currentRed: currentMergeConflict !== undefined
          ? (conflictedFilePaths(currentMergeConflict) ?? []).map(path => `conflict:${path}`)
          : noReviewYet ? (currentCiFailures ?? []).map(f => f.name)
          : review.criteria.filter(c => !c.met).map(c => `review:${c.claim}`),
        ledger: [...persisted.filter(row => !roundRows.some(local => row.step === local.step &&
          row.round_id === local.round_id && row.head_sha === local.head_sha && row.strike === local.strike)), ...roundRows],
        operatorAnswer: opts.constraint, formerCeiling: retriggers >= retriggerCap ? retriggerCap : opts.strikeCap,
        parkedReason: consecutiveMergeRefusalReasons.length > 0
          ? `Consecutive merge refusals:\n${consecutiveMergeRefusalReasons.join("\n")}` : progressRoundReason });
      const { decision, receipt } = await resolveFixProgress(input, persisted,
        { judge: progressJudge, firstRound: true, reviewInputDigest: progressReviewInputDigest,
          contractRevision: currentContractRevision });
      deps.log(receipt.step, { pr_number: prNumber, head_sha: review.headSha,
        site: retriggers >= retriggerCap ? "fix-retrigger" : "fix-strike",
        parked_reason: input.parkedReason, former_ceiling: input.formerCeiling, red_class: input.redClass,
        round_count: input.rounds.length, signals: input.signals, ...decision, ...receipt });
      if (decision.verdict === "unavailable") return { outcome: "handed_off", review, strikes, retriggers, reason: decision.reason };
      if (decision.verdict === "escalate") {
        const loop = `fix progress loop: ${decision.loop} — ${decision.reason}`;
        // W1-T177 SITE (ii): a PR that went terminal mid-rung never files a needs-human issue.
        const preEscalateStandDown = await fixRungStandDownReason(deps.readLiveState, opts.prUrl, "rung.exhaustion", deps.log);
        if (preEscalateStandDown) {
          deps.log("fix.stood_down", { site: "rung.exhaustion", strikes, reason: preEscalateStandDown.reason });
          deps.say(`fix rung: standing down before escalation — ${preEscalateStandDown.reason}`);
          return { outcome: "stood_down", review, strikes, retriggers, reason: preEscalateStandDown.reason, standDownReason: preEscalateStandDown.reason };
        }
        // The judge decides WHEN to stop; the escalation still names the mode's own evidence (W1-T100/W1-T106).
        const stillConflicted = currentMergeConflict !== undefined;
        const unmet = review.criteria.filter((c) => !c.met);
        const issueUrl = await escalateWithJudge({ class: "BLOCKED", taskId: opts.taskId, runId: opts.runId,
          headSha: review.headSha, cause: escalationCause(stillConflicted, noReviewYet),
          summary: stillConflicted
            ? `conflicted fix rung stopped by the progress judge (${strikes} strike(s), merge state never resolved): ${decision.loop} — ${opts.prUrl}`
            : noReviewYet
            ? `blocked_ci fix rung stopped by the progress judge (${strikes} strike(s), checks never went green): ${decision.loop} — ${opts.prUrl}`
            : `blocked_review fix rung stopped by the progress judge (${strikes} strike(s)): ${decision.loop} — ${opts.prUrl}`,
          detail: `${loop}\n\n` + (stillConflicted
            ? `Conflicting file(s):\n\n` +
              renderEscalationEvidence(currentMergeConflict?.files ?? [], (f) => `- ${f.path}`, true) +
              (consecutiveMergeRefusalReasons.length > 0 ? `\n\nConsecutive merge refusals:\n${consecutiveMergeRefusalReasons.map((r, i) => `${i + 1}. ${r}`).join("\n")}` : "")
            : noReviewYet
            ? `Required checks are STILL red — no review has run yet. Failing check(s):\n\n` +
              renderEscalationEvidence(currentCiFailures ?? [], (f) => `- ${summarizeCiFailure(f)}`, currentCiFailures !== undefined) +
              (() => {
                const trajectory = renderCiTrajectoryLine(everRedCiCheckNames, (currentCiFailures ?? []).map((f) => f.name));
                return trajectory ? `\n\n${trajectory}` : "";
              })()
            : `The review gate is STILL failing. Unmet criteria:\n\n` +
              renderEscalationEvidence(unmet, (c) => `- ${c.claim}\n  reason: ${c.reason}`, review.criteria.length > 0)),
          options: [{ label: "hand-fix", detail: loop }, { label: "close", detail: "close the PR and re-scope the task if the named loop cannot be broken." }],
          recommendation: "hand-fix" },
          { issues: deps.escalationIssues ?? deps.issues, ledgerPath: deps.ledgerPath, runId: opts.runId, judge: escalationJudge });
        const exhaustionReason = stillConflicted ? "merge_conflict_unresolved" : noReviewYet ? "ci_never_green" : "review_still_failing";
        deps.log("fix.exhausted", { strikes, issue_url: issueUrl, reason: exhaustionReason, judged_loop: decision.loop });
        deps.say(`fix rung: stopped by the progress judge after ${strikes} strike(s) — escalated: ${issueUrl}`);
        return { outcome: "escalated", review, strikes, retriggers, reason: loop, issueUrl };
      }
      progressApproach = decision.verdict === "change-approach" ? decision.approach : undefined;
    }

    // W1-T2272 SITE — ACCEPTANCE-AUTHOR-GATE BODY REPAIR, BEFORE `strikes++`/any commit (design
    // note ii — "a body-only defect needs no commit"). SCOPED TO A CI-LOG ROUND WHOSE OWN EVIDENCE
    // NAMES THE GATE (`currentCiFailures` contains `ACCEPTANCE_AUTHOR_GATE_CHECK_NAME`) — never
    // "any ci-log round": a PR failing for an UNRELATED reason (a real test failure, a lint error)
    // must still reach the ordinary strike below, and short-circuiting on some incidental body
    // defect of its own would spend the round on a check that was never what's blocking it
    // (MEASURED regression while building this: `test/fix-dedup-seed.test.ts`'s own header-less
    // fixture body, dispatched for an unrelated `ci` check failure, was "repaired" and consumed
    // the only strike before the real fix worker ever ran). This also keeps this SITE from ever
    // touching `body-coverage`'s own `fetchPrBody`/`deriveChangesetClaimUpdate` arm (W1-T307/
    // W1-T1254) below, a different concern this task's design note (iv) leaves untouched. It is a
    // structural no-op for any plan-tracked task's PR either way: `ensureTaskTrailer` stamps a
    // real `Remudero-Task:` trailer unconditionally, which short-circuits `acceptanceAuthorTimeCheck`
    // to `ok: true` before it ever inspects the body's own Acceptance block. It only ever fires for
    // the untracked/synthetic PRs `fixRungTaskFor` (W1-T923) already made this rung eligible to
    // touch — never a widening of WHICH PRs the rung may act on (this task's note, Q1/Q2).
    //
    // `acceptanceGateBodyRepair` (pure, above) is `undefined` for a healthy body, for `no-trailer`/
    // `unparseable` (design note i — not deterministically repairable, so left for the ordinary
    // strike below), and whenever the live fetch itself fails (fail OPEN, same discipline as every
    // other best-effort read in this rung).
    if (
      currentMergeConflict === undefined &&
      noReviewYet &&
      currentCiFailures?.some((f) => f.name === ACCEPTANCE_AUTHOR_GATE_CHECK_NAME)
    ) {
      const fetchBody = deps.fetchPrBody ?? host.fetchPrBodyViaGh;
      let liveBody: string | undefined;
      try {
        liveBody = await fetchBody(opts.prUrl);
      } catch (e) {
        deps.log("fix.body_gate_check_error", { strike: strikes + 1, error: String((e as Error)?.message ?? e) });
      }
      // A proof from a test the PR adds misses at base; the generic default does not, so it is the last resort only.
      const added = (deps.addedTestsAtHead ?? ((sha: string) => host.addedTestFilesAtHead(sha, opts.worktreePath)))(review.headSha);
      const headOnly = added.kind === "read" ? added.files.map(host.addedTestCriterion) : [];
      const readDiff = () => (deps.diffAtHead ?? ((sha: string) => host.diffSinceMergeBase(opts.worktreePath, sha)))(review.headSha);
      const repair =
        liveBody !== undefined
          ? host.acceptanceGateBodyRepair(liveBody, bodyRepairFallback(liveBody, headOnly, readDiff, deps.log, { pr_url: opts.prUrl }))
          : undefined;
      // W1-T3506 — THE WRITE-BOUNDARY CALL W1-T3389's HELPER WAS SHIPPED WITHOUT. `repair` above is
      // PURE and never inspects whether its own authored `grep:` proofs actually run — that is
      // exactly the asymmetry `repairedProofsAreSafeToPush` (lib/body-repair.ts) exists to close,
      // and closing it here, once, at the ONE place a repaired body reaches `updatePrBody`, is this
      // task's whole scope. `parseAcceptanceBlock` reads the EXACT candidate criteria this write is
      // about to push — never `liveBody`'s own (already-defective) block — through the SAME parser
      // `acceptanceAuthorTimeCheck` itself reuses, so this refuses on what would actually ship.
      const repairedCriteria = repair !== undefined ? parseAcceptanceBlock(repair.repairedBody) : [];
      // NO internal `?? execGrepProofInWorktree(...)` FALLBACK HERE, unlike `fetchPrBody`/
      // `updatePrBody` just above — this dep is genuinely OPTIONAL the way `readCiRollup`/
      // `fetchPrDiffFiles` already are (their own docs: "omitted... skips this check entirely").
      // `diagnoseUnrunnableProofs` already treats an absent `execProof` as "cannot settle real
      // execution without a runner" and silently limits itself to the pure parse-shape check — so
      // omitting this dep degrades to catching only a structurally-malformed proof (criterion 1),
      // never a false refusal. The real production call site below wires the real worktree
      // executor explicitly, exactly like its own `fetchPrBody: fetchPrBodyViaGh`.
      const proofExecDeps = { execProof: deps.execAcceptanceGateRepairProof };
      const repairSafeToPush = repair === undefined || repairedProofsAreSafeToPush(repairedCriteria, proofExecDeps);
      if (repair && !repairSafeToPush) {
        // REFUSE the write; PRESERVE the old body (never call updatePrBody) — the falsifier this
        // task ships against removes exactly this call and expects criteria 1/2 to then observe
        // `updatePrBody` invoked regardless. Falling through (no `continue`) lets the round proceed
        // to whatever it would have done had `acceptanceGateBodyRepair` itself returned `undefined`
        // — never a special "refused" strike, since nothing was written and nothing should be spent
        // on the refusal alone.
        deps.log("fix.body_gate_repair_proof_unsafe", {
          strike: strikes + 1,
          pr_number: prNumber,
          defect: repair.defect,
          reason: renderBodyDefects(diagnoseUnrunnableProofs(repairedCriteria, proofExecDeps)),
        });
        deps.say(
          `fix rung: refused an author-time acceptance-gate body repair — its repaired body carries ` +
            `an authored proof that will not parse/execute; the live body is left unchanged: ${opts.prUrl}`,
        );
      } else if (repair) {
        const attempt = strikes + 1;
        const writeBody = deps.updatePrBody ?? host.updatePrBodyViaGh;
        try {
          await writeBody(opts.prUrl, repair.repairedBody);
          // A body repair COUNTS exactly as any other attempt (this task's note, Q3) — the SAME
          // `fix.dispatch` step `priorStrikesFor` reads toward the strike cap, tagged distinctly
          // (`mode: "body-repair"`) so ledger forensics can still tell a repair apart from a
          // spawned worker. No worker runs, no commit lands, and the head sha is UNMOVED by
          // construction — `updatePrBody` is `gh pr edit --body`, never a push (acceptance
          // criterion 1). Never recorded against `unmet_count`/any task's own criteria (acceptance
          // criterion 4) — this only ever fixes the body's SHAPE.
          strikes = attempt;
          // W1-T2306: TAG THIS STRIKE WITH THE VERDICT REGIME IT WAS SPENT UNDER — the SAME
          // computation the ordinary dispatch below uses (W1-T199), not a bespoke one, so both
          // `fix.dispatch` writers agree on what "executed" means. Before this, this arm was the
          // ONLY writer of `fix.dispatch` that omitted `verdict_regime` — an omission read by
          // `strikeRegimeOf` as "keyword_only" BY CONSTRUCTION (never a decision), which let the
          // amnesty in `priorStrikesFor` erase every body-repair strike the instant the task's
          // regime turned "executed", however many were spent (this task's rationale, §1/§2).
          const verdictRegime = strikeRegimeForDispatch(review.criteria);
          deps.log("fix.dispatch", {
            strike: strikes,
            strike_cap: opts.strikeCap,
            unmet_count: 0,
            round: attempt === 1 ? "resume" : "fresh",
            mode: "body-repair",
            defect: repair.defect,
            verdict_regime: verdictRegime,
            head_sha: review.headSha,
          });
          deps.say(
            `fix rung: strike ${strikes}/${opts.strikeCap} — repaired an author-time acceptance-gate ` +
              `defect (${repair.defect}) with a body-only write; head sha unmoved: ${opts.prUrl}`,
          );
          // No worker spawned and no commit made this round — the unchanged-tree gate (W1-T1284,
          // `rung.strike` above) catches an unproductive repeat on the VERY NEXT iteration
          // (acceptance criterion 6), so loop back to the top rather than falling through to an
          // ordinary strike this round.
          continue;
        } catch (e) {
          deps.log("fix.body_gate_repair_error", { strike: attempt, error: String((e as Error)?.message ?? e) });
          // Best-effort, mirroring W1-T307's own `fix.body_claim_update_error` discipline: a
          // failed write falls through to the ordinary strike path below rather than blocking
          // the rung on an infrastructure hiccup.
        }
      }
    }

    // W1-T1282 SITE — THE ZERO-ENUMERABLE-FAILURES GUARD, BEFORE `strikes++`: dispatch's own
    // `checksState` (the check-run/status rollup) and this rung's ci-log EVIDENCE (`ciFailures`,
    // a separate miner keyed off `detailsUrl`) are two independent readers — see this shard's own
    // rationale for why they can disagree. A ci-log round (`noReviewYet`, never a merge-conflict
    // round, which carries its own evidence shape) whose evidence miner enumerated ZERO failing
    // checks has nothing to hand a fix worker: dispatching it anyway burns a strike and, at the
    // strike cap, escalates an issue whose own "Failing check(s)" section prints its own emptiness
    // — measured verbatim on #2641/issues/2653: "(no evidence — this was checked and is empty)".
    // `currentCiFailures` must be a REAL (defined) empty array here, never `undefined` —
    // `undefined` means "no `deps.fetchCiFailures` dep, or one that threw", i.e. failing-check
    // DETAIL is simply UNKNOWN, not zero (see the `?? []` comment further down); standing down on
    // an unknown would be fail-CLOSED, exactly what this rung's fail-open discipline forbids
    // everywhere else. Checked every round, not just the first — a later strike's own push can
    // leave CI non-green while the refreshed miner still enumerates nothing (the SAME split,
    // recurring mid-rung). Mirrors the shape `fixRungStandDownReason`'s three ledger-only reasons
    // (terminal state / redCheckSupersession / mergeConflictCheck) and the W1-T1223 cancelled-
    // check arm (`runSweep`, sweep.ts) already use: never fall through to a strike, never log
    // `fix.dispatch` (the one ledger step a strike is counted from) — ledger the reason and stand
    // down, exactly as those sites do.
    if (noReviewYet && currentCiFailures !== undefined) currentCiFailures = dropDerivativeAggregateCiFailure(currentCiFailures);
    if (currentMergeConflict === undefined && noReviewYet && currentCiFailures !== undefined && currentCiFailures.length === 0) {
      const reason =
        "blocked_ci dispatch with zero enumerable failing check(s) — the checks-red rollup and the ci-log " +
        "evidence miner disagree, so there is nothing to hand a fix worker; standing down rather than " +
        "spending a strike on empty evidence";
      // W1-T2804: `pinnedSha` is the head THIS round's gate read resolved, falling back to the sha
      // the dispatching sweep resolved. Reporting it is what turns "the two readers disagree" from
      // an assertion about two possibly-different commits into a claim about one observable one.
      const pinnedSha = currentPinnedSha ?? opts.ciEvidenceDisagreement?.sha;
      const disagreement = opts.ciEvidenceDisagreement
        ? {
            ...(pinnedSha ? { sha: pinnedSha } : {}),
            rollup: opts.ciEvidenceDisagreement.rollup,
            miner: host.ciEvidenceDisagreementObservation({ ciFailures: currentCiFailures }).miner,
          }
        : host.ciEvidenceDisagreementObservation({ ciFailures: currentCiFailures, sha: pinnedSha });
      deps.log("fix.ci_evidence_disagreement", {
        site: "rung.empty_ci_failures",
        strike: strikes + 1,
        reason,
        sha: disagreement.sha,
        rollup: disagreement.rollup,
        miner: disagreement.miner,
      });
      deps.log("fix.stood_down", { site: "rung.empty_ci_failures", strike: strikes + 1, reason });
      deps.say(`fix rung: standing down before strike ${strikes + 1} — ${reason}`);
      return { outcome: "stood_down", review, strikes, retriggers, reason, standDownReason: reason };
    }

    // W1-T2551 SITE — GENERATOR-BACKED GATE FIX, BEFORE `strikes++`/any worker spawn: a ci-log
    // round whose EVERY failing check's own log names a declared generator fix
    // ({@link allCiFailuresAreGeneratorFixable}) is resolved by running that generator directly —
    // never by spawning a worker (acceptance criterion 1), and never counted as a strike (this
    // task's rationale (3): the CURRENT behavior spends a strike reaching a command the gate
    // already named, which is exactly the defect this site closes). Gated on BOTH
    // `runGeneratorScript`/`commitGeneratorOutput` being wired — absent either, this whole site is
    // a structural no-op, fail OPEN exactly like every other optional dep in this rung, so every
    // pre-existing caller (none of which wires these) is byte-for-byte unaffected. A MIXED or
    // unrelated failure set still reaches the ordinary strike below completely unchanged
    // (acceptance criterion 3) — {@link allCiFailuresAreGeneratorFixable} itself is what enforces
    // "every failure or none", never a partial run.
    if (
      currentMergeConflict === undefined &&
      noReviewYet &&
      currentCiFailures !== undefined &&
      currentCiFailures.length > 0 &&
      generatorFixAttempts < GENERATOR_FIX_ATTEMPT_CAP &&
      deps.runGeneratorScript &&
      deps.commitGeneratorOutput &&
      allCiFailuresAreGeneratorFixable(currentCiFailures, deps.packageScripts ?? {})
    ) {
      generatorFixAttempts++;
      const runGeneratorScript = deps.runGeneratorScript;
      const commitGeneratorOutput = deps.commitGeneratorOutput;
      let generatorPush: FixRungOutcome | "refused" | undefined;
      const generatorResult = await runGeneratorFixForCiFailures({
        failures: currentCiFailures,
        scripts: deps.packageScripts ?? {},
        worktreePath: opts.worktreePath,
        taskId: opts.taskId,
        branch: opts.branch,
        deps: {
          runScript: runGeneratorScript,
          commit: (o) => commitGeneratorOutput(o),
          push: async (o) => {
            generatorPush = await landRoundPush(() => deps.push(o.cwd, o.branch, o.expectedHeadSha), o.expectedHeadSha, "rung.generator_fix");
          },
        },
      });
      if (generatorPush === "refused") continue;
      if (generatorPush) return generatorPush;
      if (generatorResult.applied) {
        deps.log("fix.generator_fix", {
          strike: strikes,
          attempt: generatorFixAttempts,
          generators: generatorResult.generators,
          commit_sha: generatorResult.commitSha,
        });
        deps.say(
          `fix rung: generator-fix — ran ${generatorResult.generators.map((g) => `'npm run ${g}'`).join(", ")} directly ` +
            `(W1-T2551), no strike spent` +
            (generatorResult.commitSha ? ` — committed ${generatorResult.commitSha.slice(0, 7)}` : " — already fresh, nothing to commit"),
        );
        if (generatorResult.commitSha === undefined) {
          // Nothing changed (a race, or the artifact was already fresh) — re-looping without a
          // fresh push would spin on the exact same evidence forever; fall through to the
          // ordinary rung this round instead of `continue`-ing.
        } else {
          // A commit landed — wait for CI to react to this push, same as an ordinary strike's own
          // push. `noReviewYet` stays TRUE regardless of the wait's own outcome: this rung never
          // ran a worker this round, so there is no fresh review report to hand `deps.runReview`
          // the way the ordinary strike path below does — flipping to review-mode here would
          // dispatch the NEXT round against the stale placeholder `review` this rung started with
          // (empty `criteria`), exactly the "empty reviewer-unmet dispatch" defect W1-T2236 (the
          // `gate-fix` mode's own rationale) measured and closed elsewhere. Refresh the ci-log
          // evidence instead (mirrors the ordinary strike's own post-push refresh, below): if
          // nothing is red anymore, the NEXT iteration's `rung.empty_ci_failures` guard (W1-T1282,
          // above) stands this down cleanly with no strike spent; if something else is still red,
          // the next iteration re-derives from THAT — either another generator-fixable round, or a
          // real fall-through to the ordinary worker dispatch.
          const gated = await deps.waitForCiGreen(opts.prUrl, deps.log);
          const handoff = ciHandoff(gated);
          if (handoff) return handoff;
          currentPinnedSha = ciGateSha(gated) ?? currentPinnedSha;
          if (deps.fetchCiFailures) {
            try {
              currentCiFailures = await deps.fetchCiFailures(opts.prUrl, ciGateSha(gated));
              for (const f of currentCiFailures) everRedCiCheckNames.add(f.name);
            } catch (e) {
              deps.log("fix.ci_failures_fetch_error", { strike: strikes, error: String((e as Error)?.message ?? e) });
            }
          }
          continue;
        }
      } else if (generatorResult.escalate) {
        // Rationale (4): a generator whose own regeneration still fails its own check is a REAL
        // failure — never commit a non-fix, and never silently retry forever (the attempt cap
        // above bounds that too). Falls through to the ordinary ci-log strike below UNCHANGED:
        // this site's own log line is diagnostic only — the rung's EXISTING strike-exhaustion
        // escalation, unchanged, is what eventually opens the BLOCKED issue if the worker below
        // cannot resolve it either.
        deps.log("fix.generator_fix_escalate", {
          strike: strikes,
          generator: generatorResult.escalate.generator,
          detail: generatorResult.escalate.detail,
        });
        deps.say(
          `fix rung: generator-fix — 'npm run ${generatorResult.escalate.generator}' did not resolve its own check; ` +
            `falling through to the ordinary fix rung`,
        );
      }
    }

    // W1-T1227 SITE — SCOPE GATE, BEFORE `strikes++`: a prior strike (this invocation's own, the
    // only kind reachable here — round 1 has strikes===0 and an unchanged baseline, so this is a
    // structural no-op on the very first pass) may have pushed a path outside the task's declared
    // scope. Dispatching ANOTHER strike on top of that would compound on a PR the next round's
    // rule-15/rule-25 refusal already cannot recover from (the verdict is write-once per sha, W1-T297)
    // — this rationale's whole complaint is that today's ONLY catch for that (`review.criteriaTampered`
    // / `review.instrumentEntangled`, below) fires a whole round later, only after CI has gone green
    // and a full review has run. This check needs neither: it reads the live changed-file list
    // directly, so it fires as soon as the offending push is visible on GitHub, escalating instead of
    // spending another strike. An omitted reader skips the check; an unreadable diff stands down.
    // This never writes the PR body or the task record — it only
    // ledgers, says, and (like the rule-15/rule-25 refusals beside it) escalates.
    //
    // W1-T2653: this round's own declared remedy file(s) — the failing check(s) THIS strike is
    // actually addressing, per `currentCiFailures`' own names, may each declare a remedy in
    // FAST_GATE_STEPS (lib/ci-parity.ts). Computed here (rather than read from a module-scope
    // global) so the coupling is visible at this call site and the scope gate stays PURE — this
    // is the ONLY caller-side state it needs. Reused, unchanged, by the prompt render below so the
    // gate and the instruction it dispatches can never name a different set (design note iii).
    const logNamedPaths = ciLogNamedSourcePaths(currentCiFailures ?? [], opts.worktreePath);
    const logNamedMain = mainOwnedPaths(opts.worktreePath, logNamedPaths.map((file) => file.path));
    if (logNamedMain.owned.length > 0 || logNamedMain.outcome === "unreadable") {
      deps.log("fix.remedy_path_main_owned", { outcome: logNamedMain.outcome, paths: logNamedMain.owned,
        ...(logNamedMain.reason === undefined ? {} : { detail: logNamedMain.reason }) });
    }
    const namedReachablePaths = logNamedPaths.filter((file) => !logNamedMain.owned.includes(file.path));
    const remedyExecution = recordCiRemedyExecution(ciRemedyComponent, opts.runId, {
      failingChecks: (currentCiFailures ?? []).length, matchedPaths: logNamedPaths.length,
      reachablePaths: namedReachablePaths.length, ownership: logNamedMain.outcome,
    });
    try {
      deps.log("fix.remedy_path_execution", { prevention_execution: remedyExecution,
        run_id: opts.runId, repair_pr_url: opts.prUrl });
    } catch { /* A missing observation cannot change the repair's authority or result. */ }
    const reachableRemedyFiles = [
      ...remedyFilesForFailingChecks((currentCiFailures ?? []).map((f) => f.name)),
      ...offeredCensusBaselines().map((path) => ({ path, job: "census-precheck" })),
      ...namedReachablePaths,
    ];
    if (deps.fetchPrDiffFiles && baselineDiffFiles !== undefined) {
      let currentDiffFiles: string[] | undefined;
      try {
        currentDiffFiles = await deps.fetchPrDiffFiles(opts.prUrl);
      } catch (error) {
        const reason = `PR diff unreadable: ${String(error)}`;
        deps.log("fix.stood_down", { site: "rung.pr_diff_unreadable", strike: strikes + 1, reason });
        deps.say(`fix rung: ${reason} — standing down before spending a worker round`);
        return { outcome: "stood_down", review, strikes, retriggers, reason, standDownReason: reason };
      }
      const scopeStandDown =
        currentDiffFiles !== undefined
          ? fixRungScopeStandDownReason(
              currentDiffFiles,
              baselineDiffFiles,
              admitFixTests && opts.task.files
                ? [...opts.task.files, "test/", ...admittedFixTestPaths(currentDiffFiles, opts.task.files.length > 0)]
                : opts.task.files,
              reachableRemedyFiles,
              currentCiFailures ?? [],
              host.readRegistrationChanges(opts.worktreePath, currentDiffFiles, "origin/main", undefined, currentPinnedSha),
            )
          : undefined;
      if (scopeStandDown) {
        const gateRemedy = scopeStandDown.gateRemedyDeadlock;
        const summary = gateRemedy
          ? `fix rung standing down — gate-remedy scope deadlock: ${gateRemedy.gate} prescribes ${gateRemedy.file} (${gateRemedy.declaringEntryExists ? "declared" : "missing registry entry"}) — ${opts.prUrl}`
          : `fix rung standing down — a fix worker's own repair left this PR out of scope (${scopeStandDown.scopeKind}) — ${opts.prUrl}`;
        const gateRemedyDetail = gateRemedy
          ? ` Observed blocker: failing gate ${gateRemedy.gate} prescribes ${gateRemedy.file} as its own remedy; declaring entry: ${gateRemedy.declaringEntry}.`
          : "";
        const issueUrl = await escalateWithJudge(
          {
            class: "BLOCKED",
            taskId: opts.taskId,
            runId: opts.runId,
            headSha: review.headSha,
            summary,
            detail:
              `The blocked_review FIX RUNG (W1-T76, W1-T1227) refused to dispatch strike ${strikes + 1}: ` +
              `${scopeStandDown.reason}.${gateRemedyDetail} Only a human can undo an already-pushed out-of-scope commit — the ` +
              `next round cannot, because the review verdict for this head is written once per sha (W1-T1227 ` +
              `rationale 8) and a fix worker may never edit the PR body or the task record to route around it ` +
              `(design note iv).`,
            options: [
              {
                label: "revert",
                detail: "drop the out-of-scope path(s) from this branch (revert that hunk), then re-run `rmd fix` to resume normally.",
              },
              {
                label: "widen-scope",
                detail: "if the out-of-scope path(s) genuinely belong to this task, widen the task's declared `files:` in plan/tasks.yaml, then re-run.",
              },
            ],
            recommendation: "revert",
          },
          { issues: deps.escalationIssues ?? deps.issues, ledgerPath: deps.ledgerPath, runId: opts.runId, judge: escalationJudge },
        );
        deps.log("fix.stood_down", {
          site: "rung.scope",
          strike: strikes + 1,
          reason: scopeStandDown.reason,
          scope_kind: scopeStandDown.scopeKind,
          out_of_scope_paths: scopeStandDown.newOutOfScopePaths,
          ...(gateRemedy
            ? {
                disposition: gateRemedy.disposition,
                gate: gateRemedy.gate,
                file: gateRemedy.file,
                declaring_entry: gateRemedy.declaringEntry,
                declaring_entry_exists: gateRemedy.declaringEntryExists,
                gate_remedy_source: gateRemedy.source,
              }
            : {}),
          issue_url: issueUrl,
        });
        deps.say(
          `fix rung: standing down before strike ${strikes + 1} — ${scopeStandDown.reason} — escalated: ${issueUrl}`,
        );
        return { outcome: "stood_down", review, strikes, retriggers, reason: scopeStandDown.reason, standDownReason: scopeStandDown.reason, issueUrl };
      }
    }

    // W1-T1095 (capability 1 — RECORD-AND-RESUME): a review naming an OUT-OF-DIFF blocker
    // ("blocked on #N") cannot be resolved by dispatching more code inside THIS diff — see this
    // task's rationale (3): the rung previously had no way to even RECORD that the remedy lives
    // elsewhere, so it kept striking (and eventually escalating) against work no fix worker
    // could ever complete from inside the PR. PARK instead: write a `fix.parked` row naming the
    // prerequisite and return WITHOUT spending a strike (design note iv — parking is not
    // retrying; `strikes` is read, never incremented, on this path). Checked every round, not
    // just the first, so a strike that itself regresses into naming a fresh prerequisite still
    // parks rather than grinding toward exhaustion.
    //
    // The prerequisite's OWN live state is re-read FIRST: a MERGED prerequisite means the
    // blocker is already gone, so this round falls through and proceeds as an ordinary strike
    // instead — this is capability 3, "a parked pull request resumes when its prerequisite
    // merges": nothing else on this rung treats a parked PR specially, it is simply re-invoked
    // (the same way every other dispatch already is) and this check now reads differently.
    const outOfDiffBlocker = outOfDiffBlockerFor(review);
    if (outOfDiffBlocker !== undefined) {
      // W1-T2436: the park/resume/rebase orchestration itself now lives in ONE shared place
      // ({@link parkOrResumeOnPrerequisite}) — this is capability 1's own producer
      // (`outOfDiffBlockerFor`, a review-authored "blocked on #N") handing its prerequisite
      // number to the SAME consumer capability 2's ledger-derived producer uses below.
      const outcome = await parkOrResumeOnPrerequisite(
        outOfDiffBlocker,
        { prUrl: opts.prUrl, review, strikes, retriggers },
        {
          readPrerequisiteState: deps.readPrerequisiteState,
          log: deps.log,
          say: deps.say,
          ledgerLines: deps.ledgerLines ?? (() => readLedgerLines(deps.ledgerPath)),
          readMergeFacts: deps.readMergeFacts,
          updateBranch: deps.updateBranch,
        },
      );
      if (outcome) return outcome;
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
      const issueUrl = await escalateWithJudge(
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
        { issues: deps.escalationIssues ?? deps.issues, ledgerPath: deps.ledgerPath, runId: opts.runId, judge: escalationJudge },
      );
      deps.log("fix.exhausted", { strikes, issue_url: issueUrl, reason: "rule15_violation" });
      deps.say(`fix rung: escalated (rule 15 violation) — ${issueUrl}`);
      return { outcome: "escalated", review, strikes, retriggers, reason: "rule15_violation", issueUrl };
    }

    // W1-T297 (Standing rule 25 — INSTRUMENT CHANGES RIDE ALONE), W1-T2436 (capability 2 of 3 —
    // THE MISSING PRODUCER): a diff that changes a measurement-instrument path (a
    // ratchet/coverage script, a recorded baseline, a workflow's measurement wiring, or the
    // mutation scope) AND a src/ product path in the SAME PR (see ReviewVerdict.instrumentEntangled,
    // review.ts) is never eligible for an ordinary "add the work" fix dispatch: no worker can
    // legitimately resolve an entanglement by WRITING MORE CODE into THIS PR — the only honest
    // resolutions (split the PR, or revert the instrument hunk) restructure it instead.
    //
    // W1-T1095 named three capabilities; this is the one that never shipped, and it is the one
    // the other two (park above, rebase via `runFixRebase`) both CONSUME — rationale (2):
    // `outOfDiffBlockerFor` is read 110 lines above this refusal and correctly finds nothing,
    // because the PR it would name does not exist. A mechanical partition cannot produce that PR
    // (rationale (3): both hand repairs on record required AUTHORING new code in files the
    // original PR never touched — a `git mv` opens a PR whose own CI fails), so this DISPATCHES A
    // WORKER to build the prerequisite instead of escalating immediately. Escalation still fires,
    // unchanged, the moment that worker's own attempt cannot go green (rationale (5): a REFUSAL
    // CONDITION, never a retry — a second stuck PR beside the first is worse than the escalation
    // it replaces). Zero strikes spent either way, exactly as before this task.
    if (review.instrumentEntangled) {
      const paths = review.instrumentEntanglementPaths;
      const instrumentPaths = paths?.instrumentPaths ?? [];
      const srcPaths = paths?.srcPaths ?? [];
      const instrumentList = paths ? instrumentPaths.join(", ") : "(unavailable)";
      const srcList = paths ? srcPaths.join(", ") : "(unavailable)";
      deps.log("fix.instrument_entangled", {
        strike: strikes,
        pr_url: opts.prUrl,
        head_sha: review.headSha,
        summary: review.summary,
        instrument_paths: paths?.instrumentPaths,
        src_paths: paths?.srcPaths,
      });

      // W1-T2436: the SAME escalation this refusal has always opened — reused VERBATIM (never
      // re-worded) for every "cannot go green" arm below, so a failed prerequisite attempt leaves
      // the operator with the identical, already-understood issue this rung has always filed for
      // Standing rule 25 — never a second, differently-shaped one. Design note (9): this rung must
      // never merge anything, never rebase onto an unmerged prerequisite, and must escalate exactly
      // as it does today when the prerequisite cannot go green.
      // W1-T3166: async because the escalation it opens is now judged. Wording and options are
      // untouched — W1-T2436 requires this arm to file the identical, already-understood issue.
      const escalateInstrumentEntangled = async (): Promise<string> =>
        await escalateWithJudge(
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
          { issues: deps.escalationIssues ?? deps.issues, ledgerPath: deps.ledgerPath, runId: opts.runId, judge: escalationJudge },
        );
      // W1-T3166: async for the same reason as escalateInstrumentEntangled — its escalation is
      // now judged. Both return sites await; the outcome is unchanged.
      const escalateAndExhaust = async (): Promise<FixRungOutcome> => {
        const issueUrl = await escalateInstrumentEntangled();
        deps.log("fix.exhausted", { strikes, issue_url: issueUrl, reason: "instrument_entangled" });
        deps.say(`fix rung: escalated (instrument entanglement) — ${issueUrl}`);
        return { outcome: "escalated", review, strikes, retriggers, reason: "instrument_entangled", issueUrl };
      };

      // W1-T2436: this PR's own memory of whether it already dispatched a prerequisite — see
      // `priorPrerequisitePrFor`'s own doc for why this is ledger-keyed rather than review-text-
      // keyed (a fresh review of this unchanged entangled diff reports `instrumentEntangled: true`
      // forever, so `outOfDiffBlockerFor` can never discover a prerequisite THIS capability itself
      // produced). Never re-dispatches a SECOND worker for a split already produced. Read ONCE —
      // the materialized array is reused below for `parkOrResumeOnPrerequisite`'s own ledger read
      // too, rather than re-opening and re-parsing the same file a second time this round.
      const ledgerLines = (deps.ledgerLines ?? (() => readLedgerLines(deps.ledgerPath)))();
      let prerequisitePr = priorPrerequisitePrFor(ledgerLines, opts.prUrl);

      if (prerequisitePr === undefined) {
        deps.say(
          `fix rung: instrument path(s) ${instrumentList} entangled with src/ path(s) ${srcList} — dispatching ` +
            `a worker to open the prerequisite PR (never escalating straight to an issue): ${opts.prUrl}`,
        );
        const prerequisiteBranch = `run-unfiled-${systemClock.now()}`;
        const dispatchArgs = buildPrerequisitePrDispatchArgs({
          task: opts.task,
          branch: opts.branch,
          prUrl: opts.prUrl,
          worktreePath: opts.worktreePath,
          mount: opts.mount,
          settingsFile: opts.settingsFile,
          config: opts.config,
          budgetUsd: opts.budgetUsd,
          runId: opts.runId,
          taskId: opts.taskId,
          instrumentPaths,
          srcPaths,
          prerequisiteBranch,
        });
        // W1-T1044: the SAME wall-clock bound + best-effort reclaim every ordinary strike's own
        // spawn already takes (spawnFixWorkerBounded) — this dispatch is never a strike (`strikes`
        // is read, never incremented, on this whole path) but it is still a real subprocess and
        // must never be allowed to hang the rung forever.
        const prerequisiteWorkerId = host.fixWorkerRunId(opts.runId, "prerequisite", systemClock.now());
        const prerequisiteReceipt = host.fixWorkerReceipt(deps.spawn, deps.log, prerequisiteWorkerId, fixLaneBenchmarkWork(opts.task, deps.ledgerPath),
          { prUrl: opts.prUrl, roundId: prerequisiteWorkerId });
        const spawnOutcome = await host.spawnFixWorkerBounded({ ...deps, spawn: prerequisiteReceipt.spawn }, dispatchArgs, { runId: opts.runId, taskId: opts.taskId });
        const prerequisiteWorker = spawnOutcome.kind === "spawned" ? deps.account(spawnOutcome.result) : undefined;
        const prerequisiteUrl = prerequisiteWorker ? parseReport(workerTranscript(prerequisiteWorker))?.prUrl : undefined;
        const target = prerequisiteUrl ? mergeTargetFromPrUrl(prerequisiteUrl) : undefined;
        if (!target) {
          // THE REFUSAL CONDITION (rationale (5)/(9)): the dispatched worker never produced a
          // pull request this rung can address (abandoned spawn, or a worker that honestly
          // reported it could not build one) — escalate exactly as this refusal always has,
          // rather than leave a second, worker-authored stuck PR beside the first.
          deps.log("fix.prerequisite_dispatch_failed", {
            strike: strikes,
            reason: spawnOutcome.kind === "abandoned" ? "spawn wall-clock bound exceeded" : "worker opened no pull request",
          });
          return await escalateAndExhaust();
        }
        const missingReaders = [!deps.readLiveHead && "readLiveHead", !deps.fetchPrBody && "fetchPrBody"].filter(Boolean);
        const admissionRefusal = missingReaders.length
          ? `prerequisite ${prerequisiteUrl} missing required reader(s): ${missingReaders.join(", ")}`
          : await prerequisitePrAdmissionRefusal(prerequisiteUrl!, prerequisiteBranch, {
              readLiveHead: deps.readLiveHead!, fetchPrBody: deps.fetchPrBody!,
            });
        if (admissionRefusal) {
          deps.log("fix.prerequisite_dispatch_failed", { strike: strikes, prerequisite_pr: target.prNumber, reason: admissionRefusal });
          return await escalateAndExhaust();
        }
        const ci = await deps.waitForCiGreen(prerequisiteUrl!, deps.log);
        const handoff = ciHandoff(ci);
        if (handoff) return handoff;
        const ciState = host.ciGateState(ci);
        if (ciState !== "green") {
          // THE REFUSAL CONDITION, SECOND ARM: a prerequisite that CANNOT GO GREEN escalates
          // exactly as the rung does today (rationale (5)) — never merged, never rebased onto.
          deps.log("fix.prerequisite_ci_failed", { strike: strikes, prerequisite_pr: target.prNumber, ci_state: ciState });
          return await escalateAndExhaust();
        }
        deps.log("fix.prerequisite_opened", {
          strike: strikes,
          pr_url: opts.prUrl,
          prerequisite_pr: target.prNumber,
          prerequisite_pr_url: prerequisiteUrl,
          instrument_paths: instrumentPaths,
          src_paths: srcPaths,
          ...(prerequisiteWorker ? prerequisiteReceipt.ledgerFields(prerequisiteWorker) : {}),
        });
        prerequisitePr = target.prNumber;
      }

      // CAPABILITIES 1 AND 3, CONSUMED — NEVER RE-IMPLEMENTED (rationale (11)): the SAME shared
      // orchestration ({@link parkOrResumeOnPrerequisite}) capability 1's own `outOfDiffBlockerFor`
      // branch above calls — one park/resume/rebase implementation for both producers of a
      // prerequisite number, not two independently-maintained copies.
      const outcome = await parkOrResumeOnPrerequisite(
        prerequisitePr,
        { prUrl: opts.prUrl, review, strikes, retriggers },
        {
          readPrerequisiteState: deps.readPrerequisiteState,
          log: deps.log,
          say: deps.say,
          ledgerLines: () => ledgerLines,
          readMergeFacts: deps.readMergeFacts,
          updateBranch: deps.updateBranch,
        },
      );
      if (outcome) return outcome;
      // Not rebased (already contains the base, or refused) — fall through exactly like the
      // existing capability-1/3 branch above: an ordinary strike proceeds against this round's
      // review.
    }

    // W1-T166: holdout criteria are reviewer-visible but WORKER-hidden — the fix rung dispatches
    // an actual coding worker, so its unmet-criteria block must never carry a holdout criterion's
    // claim/proof text (visibleCriteria is the same filter renderAnchorBlock and runReview's
    // ledger/PR-comment text use). `rawUnmet` (unfiltered) is kept alongside `unmet` (visible-
    // only) so the empty-review-evidence guard below can tell "genuinely nothing unmet" apart
    // from "unmet, but only on a WORKER-hidden holdout criterion" (W1-T2236 design note i) —
    // the latter must keep dispatching off the review's own redacted summary, never stand down.
    const rawUnmet = review.criteria.map((c, index) => {
      const criterionIndex = review === opts.initialReview ? opts.initialCriterionIndices?.[index] ?? index + 1 : index + 1;
      return { ...c, criterionIndex, holdout: opts.task.acceptance?.[criterionIndex - 1]?.holdout ?? c.holdout };
    }).filter((c) => !c.met);
    const unmet = visibleCriteria(rawUnmet);
    const proofDiscriminationFromReview =
      opts.proofDiscrimination !== undefined &&
      currentMergeConflict === undefined &&
      !noReviewYet &&
      rawUnmet.length === 0 &&
      review.capped === true
        ? proofDiscriminationEvidenceFromCriteria(review.criteria)
        : undefined;
    // W1-T5544: the evidence SOURCE is a property of the dispatch, not of a review row — a gate-log dispatch keeps
    // its marker through the per-round re-derivation, which is what makes the round a proof-repair round.
    const proofDiscriminationNow =
      proofDiscriminationFromReview !== undefined && opts.proofDiscrimination?.source === "gate-log"
        ? { ...proofDiscriminationFromReview, source: "gate-log" as const }
        : proofDiscriminationFromReview;
    const proofRepairRound = proofDiscriminationNow?.source === "gate-log";
    // W1-T2236: this round's structured gate-failure remedy (the `gate-fix` mode's ONLY input —
    // see {@link FixEvidence.actionableGateFailures}'s own doc). Review-mode rounds only (never
    // ci-log/merge-conflict, which carry their own evidence shape). ROUND 1 (`strikes === 0`)
    // prefers the sweep's own already-computed seed (`opts.actionableGateFailures`, W1-T923's
    // producer) — `review` this early is still `buildFixRungDispatchArgs`'s lossy ledger
    // reconstruction (no `testTheater`/`changesetContradictions`), so deriving from it directly
    // would read `[]` even for the exact shape this field exists to carry. Every LATER round
    // re-derives FRESH off that round's own live re-review instead — never this stale seed — via
    // the SAME `reviewLedgerReasons`/`actionableGateFailuresFromReasons` pair the ledger's own
    // `review.posted` line uses, mirroring `currentCiFailures`' own per-round refresh via
    // `deps.fetchCiFailures`. GATED ON `unmet.length === 0` — the SAME precondition
    // `actionableGateFailuresFromLedger` (run-task.ts) enforces before ever calling
    // `actionableGateFailuresFromReasons` — because `reviewLedgerReasons` returns ONE entry per
    // VISIBLE unmet criterion too; without this guard a single genuine unmet criterion
    // (`reasons.length === 1`, the ordinary case) would be misread as a single-form gate-failure
    // remedy and wrongly derive `gate-fix` mode instead of `reviewer-unmet` (design note i is
    // additive, never a widening of when a gate failure is claimed). An evidence shape with
    // neither a real unmet set nor a named gate failure still dispatches ONCE, as
    // `reviewer-unmet` off the review's own `summary` (see the guard immediately below for
    // what happens if it recurs) — see `test/escalation-evidence-floor.test.ts`, W1-T487,
    // protected and out of this task's scope.
    const gateFailuresNow: ActionableGateFailure[] | undefined =
      currentMergeConflict === undefined && !noReviewYet && unmet.length === 0
        ? strikes === 0 && opts.actionableGateFailures !== undefined
          ? opts.actionableGateFailures
          : actionableGateFailuresFromReasons(reviewLedgerReasons(review))
        : undefined;

    // W1-T2236 SITE — THE EMPTY-REVIEW-EVIDENCE GUARD, BEFORE `strikes++`: a review-mode round
    // (merge-conflict/ci-log rounds carry their own evidence shape and their own guards above)
    // whose review is FAILING with `rawUnmet` empty (design note i: NOT ONLY the worker-visible
    // `unmet` — a review can fail on a holdout criterion ALONE (W1-T166), which empties the
    // visible `unmet` set while `rawUnmet` still carries the real, hidden reason; that shape
    // must keep dispatching exactly as before, via the review's own redacted summary, never
    // stand down) AND no structured gate-failure remedy either has NOTHING to hand a fix worker.
    //
    // Round 1 of THIS rung (`strikes === 0`) ALWAYS dispatches on that shape regardless of this
    // guard — see `test/escalation-evidence-floor.test.ts` (W1-T487, protected, out of this
    // task's scope): every one of its blocked_review fixtures runs `strikeCap: 1` and pins this
    // EXACT evidence shape (empty criteria, no gate failure) to dispatch-then-escalate on that
    // single round; a pre-strike stand-down that ALSO fired on round 1 (this task's own first
    // attempt) broke that pinned invariant and was reverted (see git history on this file). This
    // guard only fires once that same nothing-to-act-on shape has ALREADY consumed one honest
    // strike (`strikes > 0`) and then recurs UNCHANGED on a later round: spending a second,
    // third, ... strike on literally the same empty evidence is exactly the waste W1-T1282's
    // sibling ci-log guard (`rung.empty_ci_failures`, above) already refuses for the analogous
    // shape. Never falls through to a strike, never logs `fix.dispatch` — ledgers the reason and
    // stands down instead, exactly as `rung.empty_ci_failures` does. The review itself is left
    // UNTOUCHED and still FAILING, so nothing here arms a merge (design note iv).
    if (
      currentMergeConflict === undefined &&
      !noReviewYet &&
      strikes > 0 &&
      rawUnmet.length === 0 &&
      (gateFailuresNow?.length ?? 0) === 0 &&
      proofDiscriminationNow === undefined
    ) {
      const reason =
        "review failing with no unmet acceptance criterion and no actionable gate failure named, " +
        "recurring after an honest first strike already found this same nothing-to-act-on shape — " +
        "standing down rather than spending another strike on unchanged empty evidence";
      deps.log("fix.stood_down", { site: "rung.empty_review_evidence", strike: strikes + 1, reason });
      deps.say(`fix rung: standing down before strike ${strikes + 1} — ${reason}`);
      return { outcome: "stood_down", review, strikes, retriggers, reason, standDownReason: reason };
    }

    // W1-T2293 SITE — THE INFRASTRUCTURE-FAULT GUARD, BEFORE `strikes++`: unlike the guard just
    // above, this round HAS evidence (`rawUnmet` is non-empty, PLENTY of it — rationale (8)) but
    // that evidence is the keyword floor withheld because the PREVIOUS round's own re-review never
    // read the real PR body (`lastReportSubstituteCause`, set beside `deps.runReview` above). Every
    // one of {@link FIX_MODE_RULES}' five rows is a BUILD mode, so without this guard `deriveFixMode`
    // below always lands on `reviewer-unmet` for this shape and asks a worker to edit a diff that
    // was never judged (design (v): nothing here edits the PR either — it only stands down).
    // `reportSubstituteStandDownReason` (pure, above) reads the STRUCTURED cause and `review.capped`
    // (nothing anywhere in this review was ever OBSERVED), never `reason` prose (design note vii),
    // and refuses whenever ANY criterion carries an OBSERVED `executed_fail`/`executed_pass` — real
    // evidence about the repo the next fix worker can still act on (design note viii); an ordinary
    // in-progress multi-strike round (a fresh head each strike, real work converging) is never
    // `capped`, so it is never caught here.
    if (currentMergeConflict === undefined && !noReviewYet) {
      const infraFaultReason = reportSubstituteStandDownReason(rawUnmet, review.capped, lastReportSubstituteCause);
      if (infraFaultReason) {
        deps.log("fix.stood_down", { site: "rung.report_substituted", strike: strikes + 1, reason: infraFaultReason });
        deps.say(`fix rung: standing down before strike ${strikes + 1} — ${infraFaultReason}`);
        return { outcome: "stood_down", review, strikes, retriggers, reason: infraFaultReason, standDownReason: infraFaultReason };
      }
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
    // W1-T168: snapshot THIS round's dispatch target — the head sha + unmet claim set the fix worker below is
    // being sent to resolve — BEFORE `review` is reassigned to this round's freshly computed verdict, so
    // `detectReviewFalseBlock` (after the review call, below) can tell a byte-identical re-block apart from real
    // progress. Keyed on the SAME worker-visible unmet set the fix rung actually dispatches (W1-T166).
    const priorHeadSha = review.headSha;
    const roundLedger = (deps.ledgerLines ?? (() => readLedgerLines(deps.ledgerPath)))();
    const refutedFlake = flakeClaimsForHead(roundLedger, opts.taskId, priorHeadSha, prNumber).length > 0;
    const pendingScope = roundLedger.findLast((row) => row.step === "fix.scope_amendment" &&
      row.task_id === opts.taskId && row.pr_number === prNumber && row.head_sha === priorHeadSha &&
      ["created", "resumed", "branch_update_requested"].includes(String(row.outcome)));
    let scopeMergeStartSha: string | undefined;
    let scopeRecoveryEvidence: string | undefined;
    if (pendingScope && Array.isArray(pendingScope.paths)) {
      const paths = pendingScope.paths as string[];
      const resumed = await amendScope(paths, paths, priorHeadSha);
      if (resumed.kind === "refused") deps.log("fix.commit_refused", { head_sha: priorHeadSha,
        reason: resumed.detail, scope_amendment_detail: `NEEDS_SCOPE ${paths.join(",")}` });
      if (resumed.kind !== "amendment_merged") {
        return { outcome: "stood_down", review, strikes, retriggers, reason: "awaiting scope amendment branch update" };
      }
      const git = (args: string[], input?: string) =>
        (deps.scopeAmendmentGit ?? hostWorktreeGitAsync)(opts.worktreePath, args, { input, maxBuffer: 1 << 26 });
      let mergeSha: string | undefined;
      let mergeAttempted = false;
      try {
        if ((await git(["status", "--porcelain", "-z", host.GIT_UNTRACKED_FILES_ALL])).trim()) {
          throw new Error("local scope merge requires a clean worktree");
        }
        scopeMergeStartSha = (await git(["rev-parse", "HEAD"])).trim();
        await git(["fetch", "--no-tags", "origin", "main"]);
        mergeAttempted = true;
        await git(["merge", "--no-edit", "--no-ff", "refs/remotes/origin/main"]);
        mergeSha = (await git(["rev-parse", "HEAD"])).trim();
        const contract = await resolvePlanCriteriaAtHeadAsync(`Remudero-Task: ${opts.taskId}`,
          opts.worktreePath, "plan/tasks.yaml", mergeSha, git);
        const declaredFiles = contract.taskDeclaredFiles;
        if (contract.divergence || declaredFiles === undefined || !paths.every((path) => declaredFiles.includes(path))) {
          throw new Error(`the locally merged task contract does not admit the amendment paths: ${contract.divergence?.reason ?? JSON.stringify(contract.taskDeclaredFiles)}`);
        }
        opts.task = { ...opts.task, files: contract.taskDeclaredFiles, acceptance: contract.criteria };
      } catch (error) {
        let reason = `${String(error)}\n${String((error as { stdout?: unknown }).stdout ?? "")}\n${String((error as { stderr?: unknown }).stderr ?? "")}`;
        if (mergeAttempted && mergeSha === undefined) try {
          await git(["merge", "--abort"]);
        } catch (abortError) {
          const error = String(abortError);
          reason += `; merge abort: ${error}`;
        }
        let update: { ok: boolean; error?: string };
        try {
          const ports = deps.scopeAmendmentWritePorts ?? host.buildProofAmendmentWritePorts({
            taskId: opts.taskId, worktreePath: opts.worktreePath, config: opts.config,
            owner: opts.reviewBase.owner, repo: opts.reviewBase.repo, prNumber: prNumber!,
            ledgerLinesNow: roundLedger, log: deps.log, gitOps: host.buildProofAmendmentGitOps(), amendmentKind: "scope_amendment",
          }, deps.scopeAmendmentPortsIo);
          update = ports.updateBranch(opts.prUrl, priorHeadSha);
        } catch (updateError) {
          update = { ok: false, error: String(updateError) };
        }
        deps.log("fix.scope_amendment", { outcome: "branch_update_requested", ...update, reason,
          paths, head_sha: priorHeadSha, pr_number: prNumber, amendment_number: resumed.amendmentNumber, merged_locally: false });
        return { outcome: "stood_down", review, strikes, retriggers, reason: "awaiting scope amendment branch update" };
      }
      let recovery: Record<string, unknown>;
      try {
        const restored = await restoreScopeAmendmentWork(scopeWork(paths, resumed.amendmentNumber));
        recovery = { recovery_status: "restored", restored_paths: restored };
        scopeRecoveryEvidence = `Scope amendment #${resumed.amendmentNumber}: ${restored.join(", ")} restored from the round that asked for scope.`;
      } catch (error) {
        const reason = String(error);
        recovery = { recovery_status: "unavailable", recovery_reason: reason };
        scopeRecoveryEvidence = `Scope amendment #${resumed.amendmentNumber} admitted ${paths.join(", ")}. Saved work unavailable: ${reason}. Repair these admitted paths against the red below.`;
      }
      deps.log("fix.scope_amendment", { outcome: "amendment_merged", merged_locally: true, merge_sha: mergeSha,
        amendment_number: resumed.amendmentNumber, paths, head_sha: priorHeadSha, pr_number: prNumber, ...recovery });
    }
    // W1-T9807: a main-owned refusal is retried, without a worker, at the first head holding the main it compared.
    const lastScope = roundLedger.findLast((row) => row.step === "fix.scope_amendment" && row.task_id === opts.taskId && row.pr_number === prNumber);
    if (lastScope?.reason === "main-owned" && typeof lastScope.main_sha === "string" && Array.isArray(lastScope.paths) &&
        Array.isArray(lastScope.changed_paths) && host.hostWorktreeGitResult(opts.worktreePath, ["merge-base", "--is-ancestor", lastScope.main_sha, priorHeadSha]).status === 0) {
      const retried = await amendScope(lastScope.paths as string[], lastScope.changed_paths as string[], priorHeadSha);
      if (retried.kind !== "refused") {
        return { outcome: "stood_down", review, strikes, retriggers, reason: "awaiting scope amendment merge" };
      }
    }
    const priorDesign = roundLedger.find((row) =>
      row.step === "fix.needs_design" && row.task_id === opts.taskId && row.head_sha === priorHeadSha);
    if (priorDesign) {
      const reason = String(priorDesign.reason);
      const escalated = roundLedger.findLast((row) => row.step === "fix.stood_down" && row.site === "rung.needs_design" &&
        row.task_id === opts.taskId && row.head_sha === priorHeadSha && typeof row.issue_url === "string");
      let issueUrl = typeof escalated?.issue_url === "string" ? escalated.issue_url : undefined;
      let deliveryError: { error: string } | undefined;
      if (!issueUrl) try {
        issueUrl = (await escalateWithJudge({ class: "BLOCKED", taskId: opts.taskId, runId: opts.runId,
          headSha: priorHeadSha, cause: "ci", contractRevision: `needs-design:${prNumber}:${priorHeadSha}`,
          summary: `PR #${prNumber}'s fix lane handed it back NEEDS_DESIGN and stands down every pass — ${opts.prUrl}`,
          detail: `${opts.prUrl} at ${priorHeadSha}: a fix worker answered NEEDS_DESIGN, so every later pass stands down ` +
            `at this head without a round. The worker's diagnosis:\n\n${reason}`,
          options: [{ label: "repair-cause", detail: "repair what the diagnosis names; a new head resumes the fix lane" },
            { label: "hand-fix", detail: "push a fix to this PR by hand; a new head resumes the fix lane" }],
          recommendation: "repair-cause", consequence: "this PR stays red and unmerged at this head" },
        { issues: deps.escalationIssues ?? deps.issues, ledgerPath: deps.ledgerPath, runId: opts.runId, judge: escalationJudge })) || undefined;
      } catch (error) {
        deliveryError = { error: String(error) };
      }
      deps.log("fix.stood_down", { head_sha: priorHeadSha, reason, site: "rung.needs_design", issue_url: issueUrl, ...deliveryError });
      return { outcome: "needs_design", review, strikes, retriggers, reason, issueUrl };
    }
    const priorUnmetClaims = new Set(unmet.map((c) => c.claim));
    // W1-T2328: the ci-log evidence THIS round's dispatch (below) is about to target, snapshotted
    // BEFORE the strike runs — mirrors `priorHeadSha`/`priorUnmetClaims` immediately above, for
    // the ci-log mode those two exist to cover in review mode. `undefined` outside ci-log mode
    // (merge-conflict or review dispatch): {@link detectCiLogVerdictUnchanged} treats an empty/
    // absent prior evidence set as "not comparable" and abstains, so this is inert there by
    // construction, never a special case. Read again after the push below (`currentCiFailures`,
    // refreshed by `deps.fetchCiFailures`) to see whether the strike that just ran moved anything.
    const priorCiFailures = currentMergeConflict === undefined && noReviewYet ? currentCiFailures ?? [] : undefined;
    const evidenceBase: FixEvidence =
      currentMergeConflict !== undefined
        ? { mergeConflict: currentMergeConflict, constraint: progressConstraint() }
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
          { ciFailures: ciFailurePromptEvidence(currentCiFailures ?? []), constraint: progressConstraint() }
        : // W1-T2236: `gateFailuresNow` — computed above, alongside the guard this evidence
          // shape already passed — is this round's structured gate-failure remedy (undefined for
          // a ci-log/merge-conflict round, which never reaches this branch anyway). Carried
          // through unconditionally: `deriveFixMode`'s `gate-fix` row only fires when it is
          // actually non-empty, so a `[]`/`undefined` value here is inert for a genuine
          // reviewer-unmet dispatch (unmet.length > 0) exactly as before this task.
          {
            review: { unmetCriteria: unmet, summary: review.summary, findings: verifiedReviewFindingsForFix(
              roundLedger, opts.taskId, opts.prUrl, priorHeadSha,
            ) },
            actionableGateFailures: gateFailuresNow,
            proofDiscrimination: proofDiscriminationNow,
            constraint: progressConstraint(),
          };
    // W1-T6434: only while this strike still targets the head the patch was preserved at.
    const evidence: FixEvidence =
      opts.priorPartialWork && priorHeadSha === opts.initialReview.headSha
        ? { ...evidenceBase, priorPartialWork: opts.priorPartialWork }
        : evidenceBase;
    const fixMode = deriveFixMode(evidence, PROOF_REPAIR_FIX_MODE_RULES);
    await observeFeedbackInputs(opts.config.contributorAdmission, opts.feedbackContributions ?? [], "fix-adoption", deps.log);
    // W1-T3727: WHO HOLDS THIS ROUND'S GIT, read once by BOTH the prompt and the tool bound so
    // the contract and the surface cannot disagree. The caller already pushes; only the commit moves.
    const { harnessCommits: fixHarnessOwnsGit, cashTools: fixCashTools } = host.fixRoundGitOwnership(opts.config);
    const fixCensusApplies = host.fixCensusAppliesToRepo(opts.reviewBase.repo, deps.log);
    const censusSnapshotPath = fixHarnessOwnsGit && fixCensusApplies ? await deps.writeFixCensusSnapshot?.(opts.worktreePath, deps.log) : undefined;
    if (fixHarnessOwnsGit && fixCensusApplies && !deps.writeFixCensusSnapshot) {
      deps.log("fix.census_snapshot", { outcome: "unavailable", reason: "snapshot producer is not wired" });
    }
    // W1-T5544: a proof-repair round stages EXACTLY the PR's own test files plus the task's declared test paths —
    // the census-baseline offers and every src/plan path are left out, so the harness commit refuses them by name.
    const proofRepairStageable = proofRepairRound
      ? proofRepairStageablePaths(baselineDiffFiles ?? [], opts.task.files ?? [])
      : [];
    const fixDeclaredPaths = proofRepairRound
      ? proofRepairStageable
      : [...new Set([
          ...(opts.task.files ?? []), ...(baselineDiffFiles ?? []), ...reachableRemedyFiles.map((file) => file.path),
        ])];
    // A proof-repair round with no test path to stage still runs: it may end in a PROOF_AMENDMENT instead of an edit.
    if (fixHarnessOwnsGit && fixDeclaredPaths.length === 0 && !proofRepairRound) {
      const reason = "the fix has no surface to stage — declare task files or restore the PR diff before dispatch";
      deps.log("fix.stood_down", { site: "rung.empty_commit_surface", strike: attempt, reason });
      deps.say(`fix rung: ${reason} — standing down before spending a worker round`);
      return { outcome: "stood_down", review, strikes, retriggers, reason, standDownReason: reason };
    }
    // At the first prompt assembly, as the implement lane does — emitted even at zero selection.
    if (!fixSkillSelectionLogged) deps.log("skills.selection", fixSkillSelection.observation);
    fixSkillSelectionLogged = true;
    const prompt = [
      renderFixPrompt({
        harnessCommits: fixHarnessOwnsGit,
        censusSnapshotPath,
        task: opts.task,
        round: attempt,
        branch: opts.branch,
        evidence,
        skillsPart: renderSkillsPart(fixSkillSelection.selected),
        // W1-T2607: the SAME baseline captured above (before this invocation's first strike) that
        // fixRungScopeStandDownReason's pre-strike gate already exempts — so the worker is told
        // which of its own branch's out-of-scope paths are inherited, not re-derived a second way.
        baselineDiffFiles,
        // W1-T2653: the SAME list just computed above and already passed into
        // `fixRungScopeStandDownReason` for this round's scope gate — instruction and enforcement
        // read one shared value, never two independently derived ones.
        reachableRemedyFiles,
      }),
      ...(scopeRecoveryEvidence ? [scopeRecoveryEvidence] : []),
      ...(refutedFlake ? [`this red reproduced on a rerun at ${priorHeadSha}; it is not a flake. Make a real fix; another FLAKE outcome will be recorded as a no-op without a rerun.`] : []),
      ...(proofRepairRound && proofDiscriminationNow
        ? proofRepairPromptLines({ proofs: proofDiscriminationNow.proofs, stageable: proofRepairStageable })
        : []),
      // W1-T4207: the previous strike's refused commit, named from its own `fix.commit_refused` row.
      ...lastCommitRefusalPromptLines(
        (deps.ledgerLines ?? (() => readLedgerLines(deps.ledgerPath)))(),
        opts.taskId,
        fixDeclaredPaths,
      ),
      ...(censusRefusalIsCurrent()
        ? ["", "PRE-PUSH CENSUS (W1-T4693): hooks/pre-push refused the last round's push with the census rows above; the PR still shows its old head.", host.CENSUS_PUSH_NEVER_BYPASS]
        : []),
    ].join("\n");
    // W1-T199: TAG THE STRIKE WITH THE VERDICT REGIME IT WAS SPENT AGAINST. A strike
    // spent when no proof could execute is a strike against KEYWORD NOISE; one spent
    // when the floor actually ran proofs is a strike against EVIDENCE. Untagged
    // historical lines are read as "keyword_only" (see priorStrikesFor) — they were
    // all written before the executor shipped.
    const verdictRegime = strikeRegimeForDispatch(review.criteria);

    // The final fresh strike steps up: the fix mount has already failed this PR at least once.
    const strikeMount = opts.stepUpMount && round === "fresh" && attempt >= opts.strikeCap ? opts.stepUpMount : opts.mount;
    if (strikeMount !== opts.mount) deps.log("fix.step_up", { strike: attempt, from: opts.mount.model, to: strikeMount.model });
    // W1-T5535: a mount that names its provider bypasses the auction, so there is nothing to learn for.
    const learnedArms = strikeMount.provider === undefined ? await fixLearnedArmsFor(deps, { strike: attempt, round }) : undefined;
    const fixArgs: SpawnWorkerArgs = {
      cwd: opts.worktreePath,
      permissionMode: "bypassPermissions",
      settingsFile: opts.settingsFile,
      model: strikeMount.model,
      mountProvider: strikeMount.provider,
      effort: strikeMount.effort,
      maxTurns: strikeMount.maxTurns,
      maxBudgetUsd: opts.budgetUsd,
      config: opts.config,
      prompt,
      ...(censusSnapshotPath ? { env: { [host.CENSUS_SNAPSHOT_ENV]: censusSnapshotPath } } : {}),
      resumeSessionId: round === "resume" ? sessionToResume : undefined,
      ...(round === "resume" && sessionToResume ? {
        continuation: workerContinuation(previousForResume, "The current self-contained repair contract and evidence appear in the pending action below.", opts.worktreePath),
      } : {}),
      // W1-T210: ci-log mode's prompt carries an untrusted CI log tail, so no WebFetch/WebSearch.
      // W1-T4458 (iii): a round the harness commits loses Bash too, so its prompt and tools agree.
      tools: fixHarnessOwnsGit ? FIX_WORKER_TOOLS_HARNESS_COMMITS : FIX_WORKER_TOOLS,
      // W1-T3727: the surface a BLOCKED auction would divert this round to. Offered only when the
      // prompt above already said the harness commits — otherwise a retry hands a shell-less
      // worker a contract asking for `git push`.
      ...(fixCashTools === undefined ? {} : { cashTools: fixCashTools }),
      // W1-T2261: the markers `reclaimAbandonedWorker` matches an abandoned spawn's live process
      // against (`workerMarkerEnv` sets REMUDERO_RUN_ID/REMUDERO_TASK_ID). Without them every
      // candidate read `undefined` and the reclaim kill never fired on the process it exists to stop.
      runId: opts.runId,
      taskId: opts.taskId,
      ...(learnedArms ? { providerRouting: { learnedArms } } : {}),
    };

    // W1-T4458 (i): the harness starts the merge a shell-less round cannot run, so the worker only
    // resolves the conflict markers it leaves.
    if (fixHarnessOwnsGit && currentMergeConflict !== undefined) {
      const merged = (deps.startShellLessMergeConflictMerge ?? host.startShellLessMergeConflictMerge)(opts.worktreePath);
      deps.log(merged.started ? "fix.merge_started" : "fix.merge_start_failed", {
        strike: attempt,
        ...(merged.reason ? { reason: merged.reason } : {}),
      });
      // #10787: main is already in the branch and a red is known — route to it: no strike, no refused round.
      if (merged.reason === host.MERGE_UP_TO_DATE_REASON && noReviewYet && (currentCiFailures?.length ?? 0) > 0) {
        leaveMergeMode("rung.merge_up_to_date", priorHeadSha);
        continue;
      }
      if (!merged.started) {
        const refusal = merged.reason ?? "the merge of current main did not start (no reason reported)";
        consecutiveMergeRefusalReasons.push(refusal);
        const refusedRoundId = `${opts.runId}:merge-refused:${attempt}:${systemClock.now()}`;
        strikes = attempt;
        deps.log("fix.dispatch", {
          round_id: refusedRoundId,
          strike: attempt, strike_cap: opts.strikeCap, unmet_count: unmet.length, round, mode: fixMode,
          verdict_regime: verdictRegime, head_sha: priorHeadSha, reason: refusal,
          conflicted_files: conflictedFilePaths(currentMergeConflict),
        });
        deps.log("fix.commit_refused", { round_id: refusedRoundId, head_sha: priorHeadSha,
          strike: attempt, mode: fixMode, merge_start_failed: true, reason: refusal });
        deps.log("fix.done", { round_id: refusedRoundId, head_sha: priorHeadSha,
          strike: attempt, mode: fixMode, subtype: "commit_refused" });
        deps.say(`fix rung: strike ${attempt}/${opts.strikeCap} FAILED, no worker spent — the merge of current main did not start: ${merged.reason}`);
        continue;
      }
    }

    const workerHeadReflogBefore = host.readWorktreeHeadReflog(opts.worktreePath);
    // W1-T4458 (ii): this round's own starting head; whatever lands ahead of it is this round's work.
    let roundStartSha: string | undefined;
    try {
      roundStartSha = hostWorktreeGit(opts.worktreePath, ["rev-parse", "HEAD"]).trim();
    } catch {
      // Unreadable HEAD: commitCount falls back to 0, as before this task — never a throw mid-dispatch.
    }
    // #10470: guard and lease the tip the worker builds on when it merely advanced from the snapshot.
    const roundBase = fixRoundBaseHead({
      snapshotHeadSha: priorHeadSha,
      startedFromSha: roundStartSha,
      isAncestor: (ancestor, descendant) => {
        try {
          hostWorktreeGit(opts.worktreePath, ["merge-base", "--is-ancestor", ancestor, descendant]);
          return true;
        } catch (error) {
          // git exits 1 for "not an ancestor"; any other failure is unreadable ancestry, which
          // fixRoundBaseHead turns into the snapshot guard with its own reason.
          if ((error as { status?: unknown }).status === 1) return false;
          throw error;
        }
      },
    });
    // The unpublished local merge is the commit base; the push still leases the PR's original tip.
    const roundPushBaseSha = scopeMergeStartSha ?? roundBase.baseSha;
    if (roundBase.advanced) deps.log("fix.round_head_advanced", { head_sha: priorHeadSha, round_base_sha: roundBase.baseSha, reason: roundBase.reason });
    const fixRoundStartedAtMs = systemClock.now();
    const roundId = `${opts.runId}:${attempt + retriggers}:${fixRoundStartedAtMs}`;
    const fixReceipt = host.fixWorkerReceipt(deps.spawn, deps.log, host.fixWorkerRunId(opts.runId, `fix${attempt}`, fixRoundStartedAtMs), fixLaneBenchmarkWork(opts.task, deps.ledgerPath),
      { prUrl: opts.prUrl, roundId }, { root: opts.config.root }, remedyExecution);
    let fixResult: WorkerResult;
    // W1-T1219: the spawn's elapsed ms on the SUCCESS path, the field `fix.spawn_abandoned` carries
    // on failure, folded into `fix.dispatch` so a completed spawn's duration is measurable at all.
    let spawnElapsedMs: number | undefined;
    try {
      // W1-T1044: bounds this ONE spawn by wall-clock time (spawnFixWorkerBounded's doc: why).
      const spawnOutcome = await host.withPredecessorTranscriptCopies(fixArgs, {
        root: opts.config.root, taskId: opts.taskId, excludeRunId: opts.runId,
      }, (args) => host.spawnFixWorkerBounded({ ...deps, spawn: fixReceipt.spawn }, args, {
        runId: opts.runId,
        taskId: opts.taskId,
        snapshot: { headSha: priorHeadSha, failingChecks: (priorCiFailures ?? []).map((f) => f.name) },
      }), deps.log);
      if (spawnOutcome.kind === "superseded") {
        const s = spawnOutcome.superseded;
        const reason = `fix superseded (${s.condition}): ${s.oldHead.slice(0, 12)} -> ${s.newHead.slice(0, 12)}`;
        deps.say(`fix rung: STOPPED strike ${attempt}/${opts.strikeCap} — ${reason}: ${opts.prUrl}`);
        return { outcome: "stood_down", review, strikes, retriggers, reason, standDownReason: reason, superseded: s };
      }
      if (spawnOutcome.kind === "abandoned") {
        deps.say(
          `fix rung: ABANDONED strike ${attempt}/${opts.strikeCap} — worker spawn exceeded its ` +
            `${spawnOutcome.elapsedMs}ms wall-clock bound (W1-T1044): ${opts.prUrl}`,
        );
        // Mirrors the spawn-infra-blocked path immediately below: no subprocess demonstrably
        // ran to completion, so this round is never committed as a strike (W1-T127's own
        // "a strike is only spent once a worker demonstrably ran" invariant).
        return { outcome: "spawn_abandoned", review, strikes, retriggers, reason: "spawn wall-clock bound exceeded", spawnAbandonedElapsedMs: spawnOutcome.elapsedMs };
      }
      spawnElapsedMs = spawnOutcome.elapsedMs;
      fixResult = deps.account(spawnOutcome.result);
      if (fixResult.notStarted === "admission-abandoned") {
        deps.log("fix.done", { ...fixReceipt.joinFields(), round_id: roundId, head_sha: priorHeadSha,
          ...(deps.branchClaim ? { branch_claim_run_id: deps.branchClaim.id() } : {}),
          strike: attempt, round, subtype: "admission_abandoned", worker_exit: "not_spawned",
          admission_since_ms: fixResult.admissionSinceMs, cost_usd: 0, num_turns: 0 });
        deps.branchClaim?.release();
        return { outcome: "stood_down", review, strikes, retriggers, reason: "admission-abandoned",
          standDownReason: "fix admission abandoned before a worker started" };
      }
    } catch (e) {
      if (!isSpawnInfraBlockedError(e)) throw e;
      // No subprocess ever launched, nothing was billed: an INFRA-tagged $0 line, NEVER a
      // `fix.dispatch` line (the only step `priorStrikesFor` counts), so forensics can separate "the
      // task was expensive" from "the host was broken" (W1-T127 iii). The refusal propagates
      // unchanged — strikes never move, nothing escalates here; daemon.ts's `isSpawnInfraBlocked`
      // decides what happens next, exactly as for the initial implement dispatch.
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

    // W1-T5999: a worker KILLED BY A SIGNAL that left NO work (no edits, no commits) is not a refusal: no
    // `fix.dispatch`/`fix.commit_refused`, so `fixRoundTally` counts neither strike nor "refused twice", as
    // W1-T2402's thrown kill. One that left work falls through and the harness commits it (W1-T4283, #8973).
    if (fixWorkerEndedBySignal(fixResult) && !(deps.worktreeHasUncommittedChanges ?? host.worktreeHasUncommittedChanges)(opts.worktreePath) &&
      (roundStartSha === undefined || (deps.commitsAhead ?? host.commitsAhead)(opts.worktreePath, roundStartSha) === 0)) {
      deps.log("fix.done", {
        ...fixReceipt.ledgerFields(fixResult),
        round_id: roundId,
        ...(deps.branchClaim ? { branch_claim_run_id: deps.branchClaim.id() } : {}),
        head_sha: priorHeadSha,
        strike: attempt,
        round,
        session_id: fixResult.sessionId,
        subtype: "signal_terminated",
        worker_subtype: fixResult.subtype,
        worker_exit: "signal",
        worker_exit_signal: fixResult.exit.signal,
        cost_usd: fixResult.costUsd,
        num_turns: fixResult.numTurns,
        elapsed_ms: spawnElapsedMs,
      });
      deps.branchClaim?.release();
      deps.say(`fix rung: strike ${attempt}/${opts.strikeCap} worker TERMINATED BY SIGNAL (${fixResult.subtype}) — ` +
        `not a commit refusal, no strike spent: ${opts.prUrl}`);
      return { outcome: "stood_down", review, strikes, retriggers, reason: "fix worker terminated by signal",
        standDownReason: `the fix worker was terminated by a signal (${fixResult.subtype}) before it finished` };
    }

    const censusCheck = await host.checkFixCensusSnapshotAsync(opts.worktreePath, await censusSnapshotForCheck(opts.worktreePath,
      censusSnapshotPath, currentMergeConflict !== undefined, deps.writeFixCensusSnapshot, deps.log), deps.log);
    const workerHeadCreatedLocally = host.workerCreatedCurrentHead(opts.worktreePath, workerHeadReflogBefore);

    // W1-T3727: THE HARNESS COMMITS FOR A SHELL-LESS ROUND, here — before `readRoundCommits` decides
    // what this round produced and `deps.push` carries. CALLED UNCONDITIONALLY: the helper's own
    // guard (`!harnessOwnsGit || commitCount !== 0`) passes a Claude round through, and an `if` here
    // would be a branch no default-config test reaches, which `diff-coverage` refuses by name.
    // W1-T4458 (ii): `commitCount` is the REAL commits-ahead of `roundStartSha`, never a hardcoded 0,
    // so a commit the worker made itself is pushed, not re-read as "the worker changed nothing".
    let harnessCommitRefusalReason: string | undefined;
    let harnessCommitUndeclared: readonly string[] = [];
    let harnessCommitMarkerFiles: readonly string[] = [];
    let harnessCommittedSha: string | undefined;
    const harnessCommit = (report: string, options: Pick<Parameters<typeof host.harnessCommitForShellLessWorker>[0], "subjectSource" | "derivedCommit" | "fixOutcome"> = {}) => {
      if (censusCheck?.refusal) {
        harnessCommitRefusalReason = censusCheck.refusal.text;
        return 0;
      }
      return (deps.harnessCommitForShellLessWorker ?? host.harnessCommitForShellLessWorker)({
        harnessOwnsGit: fixHarnessOwnsGit,
        commitCount: opts.guardRoundHead && fixHarnessOwnsGit ? 0 : roundStartSha === undefined ? 0 : (deps.commitsAhead ?? host.commitsAhead)(opts.worktreePath, roundStartSha),
        ...(opts.guardRoundHead ? { priorHeadSha: censusRefusalIsCurrent() ? roundStartSha ?? roundBase.baseSha : roundBase.baseSha, branch: opts.branch } : {}),
        report,
        worktreePath: opts.worktreePath,
        // The prompt and pre-strike guard already permit repairs to the inherited PR diff.
        // Use that same captured baseline here; a worker's newly added paths never enter it.
        declaredPaths: fixDeclaredPaths,
        acceptance: opts.task.acceptance,
        admitTests: admitFixTests,
        ...options,
        assignmentId: fixResult.selectionAssignmentId,
        requireMergeHead: currentMergeConflict !== undefined,
        log: deps.log,
        say: deps.say,
        onRefusal: (reason, undeclared = [], markerFiles = []) => {
          harnessCommitRefusalReason = reason;
          harnessCommitUndeclared = undeclared;
          harnessCommitMarkerFiles = markerFiles;
        },
        onCommit: (sha) => { harnessCommittedSha = sha; },
      });
    };
    const fixReport = workerTranscript(fixResult);
    let fixOutcome = anchoredFixOutcome(fixReport);
    const attributeRed = async (outcome: TypedFixOutcome | undefined) => outcome?.kind !== "NEEDS_SCOPE" ? undefined : readRedAttribution({
      failingTestFiles: baseReproductionFiles(priorCiFailures ?? []), headSha: priorHeadSha, prNumber, ledger: roundLedger, rerunReproduced: refutedFlake,
      isHarnessPath: isCiHarnessPath, mainTip: () => deps.readMainTip ? deps.readMainTip() : host.mainTipViaGit(opts.worktreePath),
      changedPaths: async (main, head) => (await hostWorktreeGitAsync(opts.worktreePath, ["diff", "--name-only", "-z", `${main}...${head}`])).split("\0").filter(Boolean),
      closure: host.buildImportClosureRead(opts.worktreePath, deps.log),
      namedInClosure: async (head, files, needles) => new Set((await hostWorktreeGitAsync(opts.worktreePath, ["grep", "-ohF", ...needles.flatMap((n) => ["-e", n]), head, "--", ...files])
        .catch((error: { code?: unknown }) => { if (error.code === 1) return ""; throw error; })).split("\n").filter(Boolean)),
    });
    const branchTaskId = taskIdFromRunBranch(opts.branch);
    const unfiledScope = opts.taskId === `PR-${prNumber}` && (branchTaskId === undefined || branchTaskId === UNFILED_RUN_SENTINEL);
    const admitUnfiledOwnDiff = (action: ReturnType<typeof decideFixOutcomeAction>): ReturnType<typeof decideFixOutcomeAction> => {
      if (unfiledScope && action.kind === "scope-needed" && action.paths.every((path) => baselineDiffFiles?.includes(path))) {
        deps.log("fix.scope_amendment", { outcome: "unfiled-own-diff", paths: action.paths,
          head_sha: priorHeadSha, pr_number: prNumber, round_id: roundId });
        return { kind: "commit" };
      }
      return action;
    };
    let fixAction = admitUnfiledOwnDiff(decideFixOutcomeAction(fixOutcome, { admitTests: admitFixTests, attribution: await attributeRed(fixOutcome) }));
    const fixLeftEdits = () => (deps.worktreeHasUncommittedChanges ?? host.worktreeHasUncommittedChanges)(opts.worktreePath);
    const outcomeCommitOptions = () => ({ fixOutcome: fixOutcome?.kind,
      derivedCommit: fixOutcome?.kind === "FIXED"
        ? derivedFixCommit(priorCiFailures?.[0]?.name ?? unmet[0]?.claim ?? gateFailuresNow?.[0]?.reason ?? opts.task.title, opts.prUrl)
        : undefined });
    // W1-T4450: a round that left edits but no COMMIT_MESSAGE line is not discarded. W1-T5325: a
    // writer that cannot resume (codex/cash) gets the subject derived from the failing check on the
    // FIRST commit attempt, so the missing line is never refused and never re-asked — that re-ask was
    // a fresh session whose loss refused the whole round. A worker-authored line still wins inside
    // the helper. A resumable writer is still asked once in its own session (W1-T4052).
    // W1-T5565: identified shell-less writers derive from the known failure. Legacy results
    // without a provider retain their session re-ask; a worker-authored subject still wins.
    const derivedFirst = fixHarnessOwnsGit && (fixResult.provider ?? fixArgs.mountProvider) !== undefined && fixLeftEdits()
      ? derivedFixCommit(priorCiFailures?.[0]?.name ?? unmet[0]?.claim ?? gateFailuresNow?.[0]?.reason, opts.prUrl)
      : undefined;
    const requiresCommit = fixAction.kind === "legacy" || fixAction.kind === "commit" ||
      (fixAction.kind === "scope-needed" && fixAction.testPaths.length > 0);
    const firstOptions = outcomeCommitOptions();
    let harnessCommitCount = requiresCommit ? harnessCommit(fixReport, {
      ...firstOptions, derivedCommit: firstOptions.derivedCommit ?? derivedFirst,
    }) : 0;
    if (harnessCommitCount === 0 && harnessCommitRefusalReason === host.MISSING_COMMIT_MESSAGE_REASON && fixLeftEdits()) {
      deps.log("fix.commit_line_requested", { strike: attempt, round });
      deps.say("fix rung: no COMMIT_MESSAGE line in the report — resuming the worker's session once to ask for it");
      const askReceipt = host.fixWorkerReceipt(deps.spawn, deps.log, host.fixWorkerRunId(opts.runId, `fix${attempt}-ask`, systemClock.now()), fixLaneBenchmarkWork(opts.task, deps.ledgerPath),
        { prUrl: opts.prUrl, roundId });
      const asked = await host.spawnFixWorkerBounded(
        { ...deps, spawn: askReceipt.spawn },
        {
          ...fixArgs,
          prompt: host.missingCommitLinePrompt({
            provider: fixResult.provider ?? fixArgs.mountProvider,
            tools: fixArgs.tools,
            title: opts.task.title,
            report: workerTranscript(fixResult),
            worktreePath: opts.worktreePath,
            declaredPaths: opts.task.files ?? [],
          }),
          resumeSessionId: fixResult.sessionId,
          continuation: workerContinuation(fixResult, prompt, opts.worktreePath),
        },
        { runId: opts.runId, taskId: opts.taskId, snapshot: { headSha: priorHeadSha, failingChecks: (priorCiFailures ?? []).map((f) => f.name) } },
      );
      const answer = asked.kind === "spawned" ? deps.account(asked.result) : undefined;
      deps.log("fix.commit_line_answered", {
        strike: attempt,
        outcome: asked.kind,
        ...(answer ? { ...askReceipt.ledgerFields(answer), session_id: answer.sessionId, cost_usd: answer.costUsd, num_turns: answer.numTurns } : {}),
      });
      if (answer) {
        harnessCommitRefusalReason = undefined;
        harnessCommitUndeclared = [];
        // The last outcome in the resumed report can explicitly authorize a derived subject.
        const answeredReport = `${workerTranscript(fixResult)}\n${workerTranscript(answer)}`;
        fixOutcome = anchoredFixOutcome(answeredReport);
        fixAction = admitUnfiledOwnDiff(decideFixOutcomeAction(fixOutcome, { admitTests: admitFixTests, attribution: await attributeRed(fixOutcome) }));
        if (["legacy", "commit"].includes(fixAction.kind) || (fixAction.kind === "scope-needed" && fixAction.testPaths.length > 0)) {
          harnessCommitCount = harnessCommit(answeredReport, { subjectSource: "re-asked", ...outcomeCommitOptions() });
        }
      }
    }
    // W1-T5544: THE PROOF-REPAIR GATE, between the commit and the push. A round that committed nothing, staged a path
    // outside the stageable set, or left a named proof that does not pass at head AND fail at the merge base is
    // REFUSED here — recorded as `fix.commit_refused` (a refusal, never a strike, W1-T5542) and never pushed.
    if (proofRepairRound && proofDiscriminationNow && !(harnessCommitRefusalReason !== undefined && harnessCommitCount === 0)) {
      const gate = await (deps.proofRepairRoundRefusal ?? host.proofRepairRoundRefusalInWorktree)({
        worktreePath: opts.worktreePath,
        roundStartSha,
        stageable: proofRepairStageable,
        proofs: proofDiscriminationNow.proofs.map((p) => p.proof),
        childStore: { log: deps.log },
      });
      if (gate !== undefined) {
        harnessCommitRefusalReason = gate.reason;
        harnessCommitUndeclared = gate.undeclared;
        harnessCommitCount = 0;
      }
    }
    const harnessCommitRefused = harnessCommitRefusalReason !== undefined && harnessCommitCount === 0;
    const mergeCommitRefused = harnessCommitRefused && harnessCommitRefusalReason === host.MERGE_HEAD_ABSENT_REASON;
    if (mergeCommitRefused) consecutiveMergeRefusalReasons.push(host.MERGE_HEAD_ABSENT_REASON);
    else consecutiveMergeRefusalReasons.length = 0;
    // W1-T5227: a refusal for leftover conflict markers IS an unresolved conflict. The merge stays pending
    // (nothing was staged), so the next strike is a merge-conflict round on those files; exhaustion then
    // reports the existing merge_conflict_unresolved. No new outcome, no new escalation path.
    const markerCommitRefused = harnessCommitRefused && harnessCommitMarkerFiles.length > 0;
    if (markerCommitRefused && currentMergeConflict === undefined) {
      currentMergeConflict = {
        files: harnessCommitMarkerFiles.map((path) => ({ path, oursDeleted: 0, theirsDeleted: 0 })),
        oursLog: "",
        theirsLog: "",
      };
    }

    // W1-T2610: the sha this round believes it just committed, read as early as possible after
    // the worker returns — BEFORE the `readRoundCommits` await, the ledger writes, and the
    // follow-up harvest below, all of which are dead time in which the exact rewind this task
    // is filed against (DAEMON-1788016810368 / PR #3261 — the worktree's local ref reset back
    // to origin's tip between commit and push) can happen. Threaded to `deps.push` below so
    // `gitPushRunBranch`'s post-condition re-reads HEAD immediately before pushing and raises
    // if it no longer matches this snapshot, instead of silently pushing zero refs. Best-effort:
    // an unreadable HEAD here just means this round's push runs without the guard — the same
    // fail-open discipline every other optional read in this rung already takes.
    let expectedHeadShaForPush = harnessCommittedSha;
    try {
      expectedHeadShaForPush ??= hostWorktreeGit(opts.worktreePath, ["rev-parse", "HEAD"]).trim();
    } catch {
      // best-effort — see comment above.
    }

    // A worker DEMONSTRABLY ran (spawn returned rather than throwing) — only now is this round
    // even CANDIDATE for a real strike.
    //
    // W1-T2403 SITE — THE RETRIGGER-SHAPED COMMIT CHECK, BEFORE `strikes` IS COMMITTED: mirrors
    // the W1-T127 discipline immediately above (a candidate round only becomes real once a fact
    // about it is known) — here the fact is whether the round's OWN new commit(s) are all
    // retrigger-shaped (see `isRetriggerShapedCommit`'s own doc). Read via `deps.readRoundCommits`
    // against `priorHeadSha` (this round's own dispatch target, snapshotted above BEFORE the
    // spawn ran) — local worktree state, already reflects whatever the worker just committed,
    // never waits on `deps.push` below. Optional + fail open: an omitted or throwing reader
    // leaves `roundCommits` empty, which classifies as an ORDINARY repair, never a retrigger — an
    // unreadable signal can only ever cause a strike to spend, exactly like every other optional
    // read this rung takes.
    let roundCommits: FixRoundCommit[] = [];
    if (deps.readRoundCommits) {
      try {
        roundCommits = await deps.readRoundCommits(opts.worktreePath, priorHeadSha);
      } catch (e) {
        deps.log("fix.round_commits_read_error", { attempt, error: String((e as Error)?.message ?? e) });
      }
    }
    const roundIsRetrigger = (fixAction.kind === "legacy" || fixAction.kind === "commit") &&
      roundCommits.length > 0 && roundCommits.every(isRetriggerShapedCommit);
    const roundDiffEvidence = {
      diff_stat: roundCommits.map(c => c.diffStat ?? { changed_files: c.changedFiles }),
      ...(roundCommits.length > 0 && roundCommits.every(c => c.diffDigest !== undefined)
        ? { diff_digest: createHash("sha256").update(JSON.stringify(roundCommits.map(c => c.diffDigest))).digest("hex") } : {}),
    };

    if (roundIsRetrigger) {
      // Spends the SEPARATE, capped `retriggers` count instead of a strike — never a
      // `fix.dispatch` line, the ONLY step `priorStrikesFor` counts toward `strikeCap` — so this
      // round is recorded as a retrigger, not an ordinary repair, and never inflates strike
      // history read back from the ledger either.
      retriggers += 1;
      deps.log("fix.retrigger", {
        ...roundDiffEvidence,
        round_id: roundId,
        head_sha: priorHeadSha,
        retrigger: retriggers,
        former_retrigger_cap: opts.retriggerCap ?? DEFAULT_FIX_RETRIGGER_CAP,
        strike: strikes,
        round,
        mode: fixMode,
        commits: roundCommits.map((c) => ({ subject: c.subject, changed_files: c.changedFiles })),
        // W1-T1219: mirrors `fix.dispatch`'s own elapsed-ms field — see its doc, above.
        elapsed_ms: spawnElapsedMs,
      });
      deps.say(
        `fix rung: retrigger ${retriggers} (${round}) — this round's own commit(s) are ` +
          `RETRIGGER-SHAPED (W1-T2403: an empty commit, or a subject naming a known-flaky re-trigger) — not ` +
          `spending strike ${attempt}/${opts.strikeCap}: ${opts.prUrl}`,
      );
    } else {
      if (fixAction.kind !== "scope-needed" && (!harnessCommitRefused || mergeCommitRefused || markerCommitRefused || censusCheck?.refusal !== undefined)) strikes = attempt;
      deps.log("fix.dispatch", {
        round_id: roundId,
        ...fixReceipt.joinFields(),
        strike: attempt,
        strike_cap: opts.strikeCap,
        unmet_count: unmet.length,
        unmet_claims: unmet.map((criterion) => criterion.claim),
        // The progress judge compares these across rounds: a FIXED round followed by the same
        // reviewer-side output is a reviewer-only failure, not a worker that needs another try.
        ...(reviewerProofFailures(unmet).length > 0 ? { reviewer_proof_failures: reviewerProofFailures(unmet) } : {}),
        round,
        mode: fixMode,
        verdict_regime: verdictRegime,
        head_sha: priorHeadSha,
        ...roundDiffEvidence,
        // W1-T1219: the spawn's own elapsed milliseconds — see spawnFixWorkerBounded's own doc.
        elapsed_ms: spawnElapsedMs,
        // The ci-friction gardener prices a ci-log round against each check and failing test.
        // W1-T9057: plus the failing titles, a bounded excerpt and where the tail came from, so the filing
        // the gardener drafts can show the rounds it priced instead of "(none recorded)".
        ci_failures: (currentCiFailures ?? []).map(ciFailureLedgerEntry),
        // W1-T4803: which files conflicted, so the hot-file gardener can rank them by PR minutes.
        conflicted_files: conflictedFilePaths(currentMergeConflict),
      });
      if (!harnessCommitRefused) deps.say(
        currentMergeConflict !== undefined
          ? `fix rung: strike ${strikes}/${opts.strikeCap} (${round}) — dispatching ONE merge-conflict fix worker for ` +
            `${(currentMergeConflict.files ?? []).length} conflicting file(s)`
          : noReviewYet
          ? `fix rung: strike ${strikes}/${opts.strikeCap} (${round}) — dispatching ONE ci-log fix worker for ` +
            `${(currentCiFailures ?? []).length} failing check(s)`
          : `fix rung: strike ${strikes}/${opts.strikeCap} (${round}) — dispatching ONE fix worker for ` +
            `${unmet.length} unmet criteri${unmet.length === 1 ? "on" : "a"}`,
      );
    }
    sessionToResume = fixResult.sessionId;
    previousForResume = fixResult;
    if (harnessCommitRefused && fixAction.kind !== "scope-needed") {
      const scopeAmendment = scopeAmendmentFromFixReport(workerTranscript(fixResult));
      deps.log("fix.commit_refused", {
        round_id: roundId,
        strike: attempt,
        round,
        mode: fixMode,
        head_sha: priorHeadSha,
        reason: harnessCommitRefusalReason,
        ...(mergeCommitRefused ? { merge_commit_refused: true } : {}),
        fix_outcome: fixOutcome?.kind ?? "unstated",
        ...(fixOutcome?.kind === "FIXED" && harnessCommitRefusalReason === "the worker changed nothing" ? { fix_outcome_contradiction: true } : {}),
        ...(scopeAmendment ? { scope_amendment_detail: scopeAmendment } : {}),
        ...undeclaredPathsLedgerFields(harnessCommitUndeclared),
        ...(markerCommitRefused ? { conflict_marker_files: harnessCommitMarkerFiles } : {}),
      });
    }
    const fixClaimFields: Record<string, unknown> = {};
    // W1-T6003: a claim released before this round's fix.done (the flake path's CI wait) is still named on it.
    let releasedClaimId: string | undefined;
    const releaseRoundClaim = (): void => {
      releasedClaimId ??= deps.branchClaim?.id();
      deps.branchClaim?.release();
    };
    const logFixDoneRow = (pushedHeadSha?: string, subtype?: string, landing?: FixRoundLanding) => deps.log("fix.done", {
      ...fixReceipt.ledgerFields(fixResult), // W1-T4613: FIRST, so every field this row already carried keeps its value
      round_id: roundId,
      ...(deps.branchClaim ? { branch_claim_run_id: deps.branchClaim.id() ?? releasedClaimId } : {}),
      fix_outcome: fixOutcome?.kind ?? "unstated",
      ...(harnessCommitRefused && fixOutcome?.kind === "FIXED" ? { fix_outcome: "NOT_LANDED", worker_fix_outcome: "FIXED" } : {}),
      ...fixClaimFields,
      head_sha: priorHeadSha,
      pushed_head_sha: pushedHeadSha,
      strike: attempt,
      round,
      session_id: fixResult.sessionId,
      subtype: subtype ?? (harnessCommitRefused || fixAction.kind === "scope-needed" ? "commit_refused" : fixResult.subtype),
      ...(harnessCommitRefused || fixAction.kind === "scope-needed" ? { worker_subtype: fixResult.subtype } : {}),
      ...(fixWorkerEndedBySignal(fixResult)
        ? { worker_exit: "signal", worker_exit_signal: fixResult.exit.signal } : {}),
      ...fixRoundLandingFields(landing, fixResult.subtype, fixOutcome?.kind ?? "unstated"),
      cost_usd: fixResult.costUsd,
      billing_mode: billingMode(fixResult.childEnvKeys),
      account_label: fixResult.accountLabel,
      num_turns: fixResult.numTurns,
      // W1-T2383 (rank 2): THE CAP BESIDE THE COUNT. Absent on 233 of 233 `fix.done` rows as
      // measured 2026-08-27, against $629.99 of fix-rung spend on a surface verdict rows do not
      // contain at all (only 16 of 109 fix run ids also carry a verdict) — so nobody could tell
      // an EXHAUSTED fix run from a merely long one. `WorkerResult.maxTurns` is the W1-T303
      // INPUT (`SpawnWorkerArgs.maxTurns`, itself `opts.mount.maxTurns`), never a read-back off
      // the envelope, which is what keeps this row checkable after `mounts.yaml` moves. Omitted
      // rather than `undefined` when the spawn configured no cap.
      ...(fixResult.maxTurns === undefined ? {} : { max_turns: fixResult.maxTurns }),
    });
    // W1-T5955: the round ends here, so its branch claim does too; the CI wait holds none.
    const logFixDone = (pushedHeadSha?: string, subtype?: string, landing?: FixRoundLanding): void => {
      logFixDoneRow(pushedHeadSha, subtype, landing);
      releaseRoundClaim();
    };
    const logPushedRoundDone = (landing: FixRoundLanding): void => { // W1-T9618: only a landed round is FIXED; one that did not land spends no strike
      logFixDone(landing.landed ? landing.remoteHead ?? expectedHeadShaForPush : undefined, undefined, landing);
      if (!landing.landed) deps.log("fix.strike_refunded", { strike: attempt, head_sha: priorHeadSha, reason: "push-not-landed", push_outcome: landing.outcome });
    };
    const pushThrew = (error: unknown): FixRoundLanding => ({ landed: false, outcome: "failed", reason: String((error as Error)?.message ?? error).slice(0, 500) });
    const unlandedStrikes = () => (strikes === attempt ? attempt - 1 : strikes);
    const notLandedOutcome = (landing: Extract<FixRoundLanding, { landed: false }>): FixRungOutcome => ({ outcome: "stood_down", review,
      strikes: unlandedStrikes(), retriggers, reason: `fix round push did not land (${landing.outcome})`, standDownReason: `fix round push did not land (${landing.outcome}): ${landing.reason}` });

    // W1-T3079: archive this worker's transcript — see the "Worker transcript archive" section
    // above `runTask`. Design note (i): "EVERY FIX WORKER EXIT" — keyed on `attempt` (this
    // round's own 1-based counter, unaffected by whether the round turned out to be a retrigger
    // or a real strike) so each round's transcript gets its own file rather than overwriting the
    // previous round's, the way the implement/diagnose archives above deliberately do.
    host.archiveWorkerTranscript(
      {
        root: opts.config.root,
        taskId: opts.taskId,
        runId: opts.runId,
        // W1-T4450: the round's own start time rides the name, so a second fix invocation in the same
        // daemon run no longer overwrites this round's transcript (every one used to be `fix-1`).
        rung: `fix-${attempt}-${fixRoundStartedAtMs}`,
        text: workerTranscript(fixResult),
        model: opts.mount.model,
        verdict: fixResult.subtype,
        headSha: expectedHeadShaForPush,
        worker: fixResult,
      },
      deps.log,
    );

    // The fix rung's own footer carries the same '## Follow-ups' invitation (renderFixPrompt
    // above); PR provenance included (the fix rung always has one).
    host.harvestFollowupsFromReport(workerTranscript(fixResult), {
      label: "fix",
      prUrl: opts.prUrl,
      runId: opts.runId,
      log: deps.log,
      say: deps.say,
    });

    if (fixAction.kind === "verify-base") {
      const files = baseReproductionFiles(priorCiFailures ?? []);
      let verified = false;
      try {
        const mainSha = await (deps.readMainTip ?? (() => {
          hostWorktreeGit(opts.worktreePath, ["fetch", "--no-tags", "origin", "main"]);
          return hostWorktreeGit(opts.worktreePath, ["rev-parse", "origin/main"]).trim();
        }))();
        const probes: BaseProbeResult = files.length > BASE_REPRODUCTION_MAX_FILES ? Object.assign([], { reason: "too many test files" }) : files.length > 0 ? await (deps.reproduceFailingTestsOnMain ??
          host.buildBaseReproductionProbe(opts.config, opts.worktreePath, deps.ledgerPath, deps.log))(
          { prNumber: prNumber!, headSha: priorHeadSha } as OpenPrView, files, mainSha,
        ) : [];
        verified = decideBaseReproduction(files, probes) === "reproduced";
        deps.log("sweep.base_reproduction", { head_sha: priorHeadSha, main_sha: mainSha, files: [...probes],
          verdict: decideBaseReproduction(files, probes),
          ...(probes.setup_error === undefined ? {} : { setup_error: boundedBaseProbeReason(probes.setup_error) }),
          ...(probes.reason === undefined ? {} : { reason: boundedBaseProbeReason(probes.reason) }) });
        if (verified) deps.log("fix.strike_refunded", { strike: attempt, head_sha: priorHeadSha,
          main_sha: mainSha, reason: "worker-base-red-verified", test_files: files });
      } catch (error) {
        deps.log("fix.base_red_verification_failed", { head_sha: priorHeadSha, reason: String(error) });
      }
      fixClaimFields.base_red_claim = verified ? "verified" : "refuted";
      logFixDone();
      return { outcome: "stood_down", review, strikes: verified ? strikes - 1 : strikes, retriggers,
        reason: verified ? "worker-base-red-verified" : "base-red claim refuted" };
    }
    if (fixAction.kind === "rerun-once") {
      if (refutedFlake) {
        fixClaimFields.flake_claim = "repeated";
        logFixDone();
        return { outcome: "stood_down", review, strikes: strikes - 1, retriggers,
          reason: "flake claim repeated after refutation — no-op round" };
      }
      const rerouted = fixAction.rerouted;
      if (rerouted) {
        const saved = await hostWorktreeGitAsync(opts.worktreePath, ["status", "--porcelain", "-z", host.GIT_UNTRACKED_FILES_ALL]).then(host.workerChangedPaths, () => undefined);
        deps.log("fix.scope_rerouted", { ...scopeReroutedFields(rerouted, fixReport, saved?.filter((path) => !fixDeclaredPaths.includes(path))), head_sha: priorHeadSha });
        fixClaimFields.flake_claim_source = "scope-rerouted";
      }
      const spent = requeuedCheckKeysFromLedger((deps.ledgerLines ?? (() => readLedgerLines(deps.ledgerPath)))());
      const failures = priorCiFailures ?? [];
      let requeued = failures.length > 0 && !!priorHeadSha;
      let deferred = false;
      for (const failure of failures) {
        const key = `${priorHeadSha}@${failure.name}`;
        if (!priorHeadSha || !failure.jobId || spent.has(key)) { requeued = false; continue; }
        spent.add(key);
        const row = { head_sha: priorHeadSha, check_name: failure.name, job_id: failure.jobId };
        deps.log(CHECK_REQUEUE_STEP, row);
        try {
          const queued = jobRequeueOutcome(await (deps.requeueCheck ??
            ((f) => requeueActionsJobOutcome(opts.reviewBase.owner, opts.reviewBase.repo, f, deps.log)))(failure));
          requeued = queued.kind === "dispatched" && requeued;
          // W1-T5920: refused while its run is in flight — unspent, and the sweep retries it.
          if (queued.kind === "deferred") {
            deferred = true;
            deps.log(CHECK_REQUEUE_DEFERRED_STEP, { ...row, refusal: queued.refusal, outcome: "deferred", error: queued.error });
          }
        } catch (error) {
          requeued = false;
          deps.log("fix.flake_requeue_failed", { head_sha: priorHeadSha, check_name: failure.name, reason: String(error) });
        }
      }
      // W1-T6003: the requeues are posted, so the round's branch work is done; its CI wait holds no claim.
      releaseRoundClaim();
      let green = false;
      if (requeued) {
        try {
          const ci = await deps.waitForCiGreen(opts.prUrl, deps.log);
          const handoff = ciHandoff(ci);
          if (handoff) { logFixDone(); return handoff; }
          green = host.ciGateState(ci) === "green" && (!ciGateSha(ci) || ciGateSha(ci) === priorHeadSha);
          for (const row of rerouted && !deferred ? fixRoundFlakeRetryRows(rerouted, green, prNumber, priorHeadSha) : []) deps.log("test.flake_retry", row);
        } catch (error) {
          deps.log("fix.flake_verification_failed", { head_sha: priorHeadSha, reason: String(error) });
        }
      }
      if (green) deps.log("fix.strike_refunded", { strike: attempt, head_sha: priorHeadSha, reason: "flake-confirmed" });
      fixClaimFields.flake_claim = green ? "confirmed" : deferred ? "requeue_deferred" : "refuted";
      logFixDone();
      return { outcome: "stood_down", review, strikes: green ? strikes - 1 : strikes, retriggers,
        reason: green ? "flake-confirmed" : "flake claim refuted" };
    }
    const amendProofs = (proofEvidence: ProofDiscriminationEvidence) => dispatchProofAmendmentWrite({
      prUrl: opts.prUrl, taskId: opts.taskId, worktreePath: opts.worktreePath, config: opts.config, reviewBase: opts.reviewBase,
      evidence: proofEvidence, transcriptText: workerTranscript(fixResult), priorHeadSha, log: deps.log,
      review: { state: review.state, capped: review.capped, criteria: review.criteria, reviewerOutcome: review.reviewerOutcome },
      getLedgerLinesNow: () => (deps.ledgerLines ?? (() => readLedgerLines(deps.ledgerPath)))(),
    });
    if (fixAction.kind === "hand-off") {
      // A NEEDS_DESIGN round still carries the PROOF_AMENDMENT its prompt asks for (W1-T8921, W1-T5689: dropped here).
      if (evidence.proofDiscrimination) amendProofs(evidence.proofDiscrimination);
      const refusalExcerpt = refusalExcerptFromFixReport(fixReport);
      deps.log("fix.needs_design", { reason: fixAction.reason, head_sha: priorHeadSha, contract_revision: currentContractRevision,
        ...(currentSemanticRevision === undefined ? {} : { task_semantic_revision: currentSemanticRevision }),
        ...(refusalExcerpt ? { report_excerpt: refusalExcerpt } : {}) });
      logFixDone();
      return { outcome: "needs_design", review, strikes, retriggers, reason: fixAction.reason };
    }
    if (fixAction.kind === "scope-needed") {
      deps.log("fix.scope_needed", { paths: fixAction.paths, head_sha: priorHeadSha,
        ...(fixAction.attribution ? { attribution: fixAction.attribution.kind, attribution_reason: fixAction.attribution.reason } : {}) });
      const workflowPaths = fixAction.paths.filter((path) => path.startsWith(".github/workflows/"));
      const instrumentPaths = fixAction.paths.filter(isUngrantableInstrumentPath);
      if (workflowPaths.length > 0 || instrumentPaths.length > 0 || unfiledScope) {
        const scopeKind = workflowPaths.length > 0 ? "workflow" : instrumentPaths.length > 0 ? "instrument" : "unfiled";
        const paths = [...new Set(fixAction.paths)].sort();
        const identityKey = createHash("sha256").update(JSON.stringify([prNumber, priorHeadSha, paths])).digest("hex");
        const prior = roundLedger.findLast((row) => row.step === "fix.scope_amendment" &&
          row.outcome === `${scopeKind}-escalated` && row.identity_key === identityKey);
        let issueUrl = typeof prior?.issue_url === "string" ? prior.issue_url : undefined;
        let deliveryError: { error: string } | undefined;
        if (!issueUrl) try {
          issueUrl = await escalateWithJudge({ class: "BLOCKED", taskId: opts.taskId, runId: opts.runId,
            headSha: priorHeadSha, cause: "ci", contractRevision: identityKey,
            summary: scopeKind === "workflow"
              ? `PR #${prNumber} needs a workflow repair outside the fix lane — ${opts.prUrl}`
              : scopeKind === "instrument" ? `PR #${prNumber} needs an instrument edit only the operator can grant — ${opts.prUrl}`
              : `unfiled PR #${prNumber} needs scope outside its own diff — ${opts.prUrl}`,
            detail: `@${opts.reviewBase.owner}: ${opts.prUrl} ` + (scopeKind === "workflow"
              ? `needs workflow edits that the fix lane cannot amend or commit: ${workflowPaths.join(", ")}.`
              : scopeKind === "instrument" ? `needs instrument edits a scope amendment always refuses (instrument-path): ${instrumentPaths.join(", ")}.`
              : "has no plan record to amend.") + ` Round ${roundId} ` +
              `needs a scope decision for these exact paths:\n${paths.map((path) => `- ${path}`).join("\n")}\n\n` +
              `Worker's NEEDS_SCOPE diagnosis (including any main-inherited cause):\n${fixReport}\n\n` +
              `Failing check signature:\n${(priorCiFailures ?? []).map((failure) => `- ${summarizeCiFailure(failure)}`).join("\n")}` +
              (scopeKind === "workflow" ? `\n\nBaked-closure catalog:\n${bakedClosureCatalogDetails((priorCiFailures ?? []).map((failure) => failure.logTail ?? "").join("\n"))}` : ""),
            options: [{ label: "route-repair", detail: "route the named paths to their owner or a filed repair task" },
              { label: "revise-pr", detail: "revise this PR's scope explicitly, then resume its fix lane" }],
            recommendation: "route-repair", consequence: "this fix lane stays down at this head until its scope is resolved" },
          { issues: deps.escalationIssues ?? deps.issues, ledgerPath: deps.ledgerPath, runId: opts.runId, judge: escalationJudge });
        } catch (error) {
          deliveryError = { error: String(error) };
        }
        const reason = issueUrl ? `${scopeKind} scope need escalated` : `${scopeKind} scope escalation undelivered`;
        deps.log("fix.scope_amendment", { outcome: issueUrl ? `${scopeKind}-escalated` : `${scopeKind}-escalation-failed`,
          identity_key: identityKey, paths, head_sha: priorHeadSha, pr_number: prNumber, round_id: roundId,
          issue_url: issueUrl, reason, contract_revision: currentContractRevision, ...deliveryError });
        deps.log("fix.stood_down", { site: `rung.${scopeKind}_scope`, head_sha: priorHeadSha, reason, paths, issue_url: issueUrl });
        logFixDone();
        return { outcome: "stood_down", review, strikes, retriggers, reason, standDownReason: reason, issueUrl };
      }
      let amendment: ScopeAmendmentOutcome;
      const readWorkerChanged = (): string[] => {
        const changed = host.workerChangedPaths(hostWorktreeGit(opts.worktreePath, ["status", "--porcelain", "-z", host.GIT_UNTRACKED_FILES_ALL]));
        if (roundStartSha) changed.push(...hostWorktreeGit(opts.worktreePath, ["diff", "--name-only", "-z", roundStartSha, "HEAD"]).split("\0").filter(Boolean));
        return changed;
      };
      // W1-T9807: main's touch refuses only a path main is repairing, one this ci-log round's red names (#10369).
      const scopeMainOwned = fixMode === "ci-log" && logNamedMain.outcome === "compared"
        ? fixAction.paths.filter((path) => logNamedMain.owned.includes(path)) : [];
      if (scopeMainOwned.length > 0) {
        amendment = { kind: "refused", reason: "main-owned",
          detail: `main changed ${scopeMainOwned.join(", ")} since this PR's merge base; refresh against main` };
        let read: { paths: string[] } | { error: string };
        try { read = { paths: readWorkerChanged() }; } catch (error) { read = { error: String(error) }; }
        const changed = "paths" in read ? read.paths : undefined;
        const mainTip = host.hostWorktreeGitResult(opts.worktreePath, ["rev-parse", "--verify", "refs/remotes/origin/main"]);
        deps.log("fix.scope_amendment", { outcome: amendment.kind, ...amendment, paths: fixAction.paths, head_sha: priorHeadSha,
          pr_number: prNumber, main_sha: mainTip.status === 0 ? mainTip.stdout.trim() : undefined,
          changed_paths: changed && fixAction.paths.filter((path) => changed.includes(path)), changed_paths_error: "error" in read ? read.error : undefined });
      } else try {
        amendment = await amendScope(fixAction.paths, readWorkerChanged(), priorHeadSha, true);
      } catch (error) {
        amendment = { kind: "refused", reason: "worker-diff-unreadable", detail: String(error) };
        deps.log("fix.scope_amendment", { outcome: amendment.kind, ...amendment, paths: fixAction.paths, head_sha: priorHeadSha });
      }
      if (amendment.kind !== "refused") {
        logFixDone(undefined, "scope_amendment_pending");
        return { outcome: "stood_down", review, strikes, retriggers, reason: "awaiting scope amendment merge" };
      }
      deps.log("fix.commit_refused", { round_id: roundId, strike: attempt, round, head_sha: priorHeadSha,
        reason: `non-test paths need scope (${amendment.reason}: ${amendment.detail})`,
        scope_amendment_detail: `NEEDS_SCOPE ${fixAction.paths.join(",")}`,
        fix_outcome: fixOutcome?.kind });
      if (harnessCommitCount > 0) {
        let landing: FixRoundLanding | undefined;
        try {
          const pushed = await landRoundPush(() => deps.push(opts.worktreePath, opts.branch, expectedHeadShaForPush, opts.guardRoundHead && fixHarnessOwnsGit ? roundPushBaseSha : undefined), expectedHeadShaForPush, "rung.strike");
          landing = await roundLanding(expectedHeadShaForPush);
          if (pushed && pushed !== "refused") return pushed;
        } catch (error) {
          landing = pushThrew(error);
          throw error;
        } finally { logFixDone(landing?.landed ? landing.remoteHead ?? expectedHeadShaForPush : undefined, undefined, landing); }
      } else logFixDone();
      if (scopeMainOwned.length > 0 && deps.updateBranch && prNumber !== undefined) {
        const refresh = { pr_number: prNumber, head_sha: priorHeadSha, red_checks: [...new Set((currentCiFailures ?? []).map((f) => f.name))],
          test_files: [], matching_base_files: scopeMainOwned, method: "merge", reason: "scope-main-owned" };
        try {
          const updated = await deps.updateBranch(prNumber);
          if (updated.ok) deps.log("fix.base_refreshed", refresh);
          else deps.log("fix.base_refresh_failed", { ...refresh, error: updated.error ?? "no error reported" });
        } catch (error) {
          deps.log("fix.base_refresh_failed", { ...refresh, error: String(error) });
        }
      }
      return { outcome: "stood_down", review, strikes, retriggers, reason: "non-test paths need scope" };
    }

    // A shell-less worker that omitted or failed its harness commit produced no new head. The
    // refusal row is the positive release signal sweep.ts reads on the next pass; do not push an
    // unchanged worktree or wait for CI against the old head. The tally stops a repeated refusal
    // separately from completed worker strikes (W1-T5542).
    if (harnessCommitRefused) {
      // W1-T5544: a proof-repair round that produced no pushable test edit may instead carry a PROOF_AMENDMENT — the
      // parent validates it on the gate-log evidence and opens the one proof-only plan PR. Best-effort, logged either way.
      if (proofRepairRound && proofDiscriminationNow) {
        amendProofs(proofDiscriminationNow);
      }
      logFixDone();
      if (censusCheck?.refusal) {
        pushRefusal = censusCheck.refusal;
        currentCiFailures = [{ name: host.CENSUS_PUSH_CHECK, logTail: censusCheck.refusal.text }];
        everRedCiCheckNames.add(host.CENSUS_PUSH_CHECK);
        noReviewYet = true;
        currentMergeConflict = undefined;
        baseRefreshChecked = true;
        continue;
      }
      if (mergeCommitRefused || markerCommitRefused) continue;
      const refusedAtHead = fixRoundTally([...(deps.ledgerLines ?? (() => readLedgerLines(deps.ledgerPath)))(), ...roundRows], opts.taskId, priorHeadSha).refusals.length;
      // W1-T7748: a worker that reported FIXED yet left nothing to commit usually found the head already
      // repaired; re-read the PR once at this head rather than stand down for a person.
      if (shouldSelfHealNothingChanged(fixOutcome?.kind, harnessCommitRefusalReason, refusedAtHead)) {
        deps.say("fix rung: the worker reported FIXED but changed nothing — re-reading the PR once before standing down");
        continue;
      }
      deps.say(
        `fix rung: refused (${Math.max(1, refusedAtHead)} at this head) by the harness — no commit was produced: ` +
          `${harnessCommitRefusalReason}`,
      );
      return {
        outcome: "stood_down",
        review,
        strikes,
        retriggers,
        reason: "harness commit refused",
        standDownReason: harnessCommitRefusalReason,
      };
    }

    let roundPush: FixRungOutcome | "refused" | undefined;
    let landing: FixRoundLanding = { landed: false, outcome: "failed", reason: "the push did not return" };
    try {
      roundPush = await landRoundPush(() => deps.push(opts.worktreePath, opts.branch, expectedHeadShaForPush, opts.guardRoundHead && fixHarnessOwnsGit ? roundPushBaseSha : undefined), expectedHeadShaForPush, "rung.strike");
      landing = await roundLanding(expectedHeadShaForPush);
    } catch (error) {
      landing = pushThrew(error);
      throw error;
    } finally {
      logPushedRoundDone(landing);
    }
    if (roundPush === "refused") continue;
    if (roundPush) return { ...roundPush, strikes: unlandedStrikes() };
    if (!landing.landed) return notLandedOutcome(landing);

    recordHeadProviderAfterPush(
      {
        taskId: opts.taskId,
        prUrl: opts.prUrl,
        source: "fix",
        worker: fixResult,
        workerHeadCreatedLocally,
        priorHeadSha,
      },
      {
        readProducedHeadSha: () => hostWorktreeGit(opts.worktreePath, ["rev-parse", "HEAD"]).trim(),
        readHeadSha: deps.readHeadShaForProvenance ?? host.readHeadShaRest,
        log: deps.log,
      },
    );

    const ci = await deps.waitForCiGreen(opts.prUrl, deps.log);
    const handoff = ciHandoff(ci);
    if (handoff) return handoff;
    const claimLostAfterCi = branchClaimLost();
    if (claimLostAfterCi) return claimLostAfterCi;
    // W1-T2804: one gate read, one sha, and the miner below is pinned to it — never a second
    // independent head resolution between the two halves of a single decision.
    currentPinnedSha = ciGateSha(ci) ?? currentPinnedSha;
    if (host.ciGateState(ci) !== "green") {
      deps.log("fix.ci_not_green", { strike: strikes, ci: host.ciGateState(ci), sha: ciGateSha(ci) });
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
          currentCiFailures = await deps.fetchCiFailures(opts.prUrl, ciGateSha(ci));
          for (const f of currentCiFailures) everRedCiCheckNames.add(f.name);
        } catch (e) {
          deps.log("fix.ci_failures_fetch_error", { strike: strikes, error: String((e as Error)?.message ?? e) });
        }
      }
      // #10787: named checks that RAN red prove GitHub computed the merge ref (a dirty PR runs none), so the next
      // round targets that red instead of re-merging main; the pre-strike gate re-probes mergeability first.
      if (host.ciGateState(ci) === "red" && (currentCiFailures?.length ?? 0) > 0) leaveMergeMode("rung.ci_red", ciGateSha(ci));

      // W1-T2328 SITE — THE CI-LOG VERDICT-UNCHANGED CHECK, RIGHT AFTER THE REFRESH ABOVE: this
      // strike's push landed and CI re-ran, but did the finding set actually MOVE? Comparing
      // `priorCiFailures` (what this strike targeted, snapshotted before dispatch above) against
      // the evidence just refreshed answers that — see `detectCiLogVerdictUnchanged`'s own doc for
      // the comparison and its abstain rule. `priorCiFailures` is `undefined` unless THIS round
      // was dispatched in ci-log mode, so a review-mode or merge-conflict-mode strike that
      // regressed CI for the first time is never compared against evidence it never had (the
      // function's own empty-array guard would abstain anyway; the `undefined` check here just
      // skips the call). Composes the SAME two outcomes `detectReviewFalseBlock` already composes
      // (design Q2's "disposition" — never a third invented one): NO ADDITIONAL STRIKE is spent
      // (this falls through to `escalated` instead of `continue`-ing to the next round's dispatch)
      // and the escalation CARRIES THE EVIDENCE, exactly like the review false-block escape below.
      if (priorCiFailures !== undefined) {
        const ciFalseBlockReason = detectCiLogVerdictUnchanged({
          priorFailures: priorCiFailures,
          currentFailures: currentCiFailures ?? [],
        });
        if (ciFalseBlockReason) {
          // The stand-in escalates here as the former rung did; a wired judge rules it at the next judgment.
          const stop = judgeIsStandIn ? await consultAtSite(ciFalseBlockReason) : undefined;
          if (stop?.verdict === "unavailable") return { outcome: "handed_off", review, strikes, retriggers, reason: stop.reason };
          if (stop?.verdict === "escalate") {
          // W1-T177 discipline extended to this NEW spending site, exactly like the review
          // false-block escape does: a fresh terminal-state read before filing a needs-human
          // issue, so a PR that went terminal between this round's push and here never gets a
          // false-block escalation opened against it either.
          const preCiFalseBlockStandDown = await fixRungStandDownReason(deps.readLiveState, opts.prUrl, "rung.ci_false_block", deps.log);
          if (preCiFalseBlockStandDown) {
            deps.log("fix.stood_down", { site: "rung.ci_false_block", strikes, reason: preCiFalseBlockStandDown.reason });
            deps.say(`fix rung: standing down before ci-log false-block escalation — ${preCiFalseBlockStandDown.reason}`);
            return {
              outcome: "stood_down",
              review,
              strikes,
              retriggers,
              reason: preCiFalseBlockStandDown.reason,
              standDownReason: preCiFalseBlockStandDown.reason,
            };
          }
          deps.log("fix.ci_false_block", { strike: strikes, reason: ciFalseBlockReason });
          deps.say(
            `fix rung: ESCAPING after strike ${strikes}/${opts.strikeCap} — ${ciFalseBlockReason} — escalating for ` +
              `re-judgment rather than striking toward exhaustion: ${opts.prUrl}`,
          );
          const issueUrl = await escalateWithJudge(
            {
              class: "BLOCKED",
              taskId: opts.taskId,
              runId: opts.runId,
              headSha: review.headSha,
              cause: escalationCause(false, true),
              summary: `ci-log false-block after ${strikes} strike(s) (${ciFalseBlockReason}) — ${opts.prUrl}`,
              detail:
                `The blocked_ci FIX RUNG (ci-log mode, W1-T94/W1-T100/W1-T2328) detected a CI-LOG FALSE-BLOCK it ` +
                `cannot resolve by dispatching more code: ${ciFalseBlockReason}. Failing check(s):\n\n` +
                renderEscalationEvidence(currentCiFailures ?? [], (f) => `- ${summarizeCiFailure(f)}`, currentCiFailures !== undefined) +
                (() => {
                  const trajectory = renderCiTrajectoryLine(everRedCiCheckNames, (currentCiFailures ?? []).map((f) => f.name));
                  return trajectory ? `\n\n${trajectory}` : "";
                })() +
                `\n\nThis strike's push landed a real commit and the check(s) re-ran, but the annotation findings ` +
                `are byte-identical to what the previous round already observed — a further strike could only ` +
                `re-discover what this one already showed. Escalating for a HUMAN RE-JUDGMENT after ${strikes} ` +
                `strike(s) instead of spending the remaining strike(s) confirming the same finding again.`,
              options: [
                {
                  label: "hand-fix",
                  detail: "resolve the failing check(s) on the same branch by hand, then push to re-trigger CI.",
                },
                { label: "close", detail: "close the PR and re-scope the task if the check itself cannot be satisfied." },
              ],
              recommendation: "hand-fix",
            },
            { issues: deps.escalationIssues ?? deps.issues, ledgerPath: deps.ledgerPath, runId: opts.runId, judge: escalationJudge },
          );
          deps.log("fix.exhausted", { strikes, issue_url: issueUrl, reason: "ci_false_block", judged_loop: stop.loop });
          deps.say(`fix rung: escalated (ci-log false-block) — ${issueUrl}`);
          return { outcome: "escalated", review, strikes, retriggers, reason: "ci_false_block", issueUrl };
          }
          progressRoundReason = ciFalseBlockReason;
          deps.log("fix.ci_false_block", { strike: strikes, reason: ciFalseBlockReason });
        }
      }

      continue; // The next judgment sees the refreshed red set and this round's finding.
    }

    // W1-T106: green CI proves the merge ref computes, so merge mode ends (a named red ends it above, #10787).
    currentMergeConflict = undefined;

    const judgedCiHead = ciGateSha(ci);
    if (judgedCiHead !== undefined) {
      const checkout = await hostWorktreeGitAsync(opts.reviewBase.headCheckoutDir, ["rev-parse", "HEAD"]).then(
        head => ({ kind: "known" as const, headSha: head.trim() }),
        error => ({ kind: "unknown" as const, reason: String(error) }),
      );
      if (checkout.kind === "unknown" || checkout.headSha !== judgedCiHead) {
        const reason = checkout.kind === "unknown" ? `review checkout unreadable after CI: ${checkout.reason}`
          : `CI judged ${judgedCiHead}, but the review checkout is ${checkout.headSha}`;
        deps.log("fix.stood_down", { site: "rung.post_ci_review_source", ci_head_sha: judgedCiHead,
          ...(checkout.kind === "known" ? { checkout_head_sha: checkout.headSha } : { checkout_error: checkout.reason }), reason });
        return { outcome: "stood_down", review, strikes, retriggers, reason, standDownReason: reason };
      }
    }

    // W1-T3501: judge the CURRENT PR BODY — the artifact the authoritative
    // reviewCommand/post-review path judges — not the fix worker's chat text. The
    // worker transcript remains available to the prompt and diagnostics, including
    // proof-discrimination's proposal parser below. Best-effort: an absent/throwing
    // fetchPrBody falls back to the worker-text report and marks it as a substitute,
    // so a transport failure cannot be certified as the PR's own claim.
    // W1-T186 round-2 note (the OBSERVED-not-inferred discipline applied to the gate
    // itself): a body-coverage fix worker that edits the PR body as its LAST action of
    // an exhausted strike (no strike budget left to re-verify) leaves the NEXT strike's
    // `remudero-review=failure` comment describing that PRIOR, already-superseded body
    // snapshot — the fetch below always reads whatever is live NOW, so a stale-looking
    // failure reason in a later round can be the gate reporting an OLD observation, not
    // a live one; re-check the CURRENT body/criteria coverage directly before assuming
    // the reported reason still holds.
    let reviewReport = workerTranscript(fixResult);
    let reviewInputBody: string | undefined;
    // W1-T1254/W1-T3501: the worker transcript starts as a substitute. Only a
    // successful read of the live PR body clears the flag; a throwing or absent
    // read must never let narrative text reach the changeset-claim detector as if
    // the author wrote it.
    let reviewReportIsSubstitute = true;
    // The default cause identifies a worker transcript that has not yet been replaced by a
    // successful body read. Only the catch below may overwrite it, so a fetch failure can never
    // be asserted by accident.
    let reviewReportSubstituteCause: import("../../lib/review.js").ReportSubstituteCause = { kind: "never-fetched", fixMode };
    const fetchBody = deps.fetchPrBody ?? host.fetchPrBodyViaGh;
    try {
      reviewReport = await fetchBody(opts.prUrl);
      reviewInputBody = reviewReport;
      // Only HERE is `reviewReport` the real PR body. A throw leaves the assignment undone and
      // the flag true, which is the honest reading: the catch below logs and falls through.
      reviewReportIsSubstitute = false;
    } catch (e) {
      reviewReportSubstituteCause = { kind: "fetch-failed" };
      deps.log("fix.body_fetch_error", { strike: strikes, error: String((e as Error)?.message ?? e) });
    }
    if (fixMode === "body-coverage") {
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
        const fetchDiffFiles = deps.fetchPrDiffFiles ?? host.fetchPrDiffFilesViaGh;
        const diffFiles = await fetchDiffFiles(opts.prUrl);
        // W1-T1264 (design (iii) — "BOTH CONSUMERS CARRY IT"): `deriveChangesetClaimUpdate` below
        // reuses `bodyContradictsDiff`'s own parse but returns only a repaired body/`undefined` —
        // never the recognition count `judgeReview`'s own verdict now carries
        // ({@link ReviewVerdict.changesetClaimsRecognised}). Logged here, at the FIX RUNG's own
        // call site, so an author debugging why the auto-repair rung did or did not touch a body
        // sees the identical "how many claims did the detector even read" number, not only the
        // verdict object judgeReview returns later this same strike.
        const recognition = recognizeChangesetClaims(reviewReport, diffFiles);
        deps.log("fix.body_claim_recognition", {
          strike: strikes,
          recognised: recognition.recognisedCount,
          contradictions: recognition.contradictions.length,
          // A drifted count is no longer a contradiction but is still what this rung repairs, so it
          // is counted here as well. Without it the row would read 0/0 on every body the rung goes
          // on to rewrite, and the log would say nothing happened.
          stale_counts: recognition.staleCountClaims.length,
          fence_unbalanced_at_eof: recognition.fenceUnbalancedAtEof,
        });
        const updatedBody = deriveChangesetClaimUpdate(reviewReport, diffFiles);
        if (updatedBody !== undefined) {
          const writeBody = deps.updatePrBody ?? host.updatePrBodyViaGh;
          await writeBody(opts.prUrl, updatedBody);
          deps.log("fix.body_claim_updated", { strike: strikes });
          deps.say(
            `fix rung: this strike's commit changed the file set — updated the PR body's stale ` +
              `changeset claim to match before re-review`,
          );
          reviewReport = updatedBody;
          reviewInputBody = updatedBody;
          // W1-T1254 design (ii): this arm just WROTE `updatedBody` to the PR, so the report IS
          // the body and must be scored as one. Leaving the flag true here would disable the
          // changeset check on the exact strike that repaired a stale claim — the fix becoming a
          // new blind spot. Set explicitly rather than relying on the fetch above having
          // succeeded: a throwing fetch still reaches this block.
          reviewReportIsSubstitute = false;
        }
      } catch (e) {
        deps.log("fix.body_claim_update_error", { strike: strikes, error: String((e as Error)?.message ?? e) });
      }
    }
    // W1-T3434: THE PARENT-OWNED CAPPED-PROOF-AMENDMENT EFFECT. `evidence.proofDiscrimination`
    // (set only for THIS mode, above) is the exact structured stale-proof evidence the prompt just
    // showed the worker; its report is asked to PROPOSE a replacement, never to edit the PR body or
    // the plan (Standing rule 15) — see prompt-render.ts's `proof-discrimination` block. Every
    // proposed entry is validated against OBSERVED state (byte-identical claim, parses, discriminates
    // head from base, never the plan shard itself) before anything is written, and a durable ledger
    // key keeps a re-dispatch from ever opening a second amendment PR. Best-effort end to end: any
    // throw here only logs and this round's ordinary re-review (below) proceeds unaffected — the
    // capped verdict still stands, exactly as before this task, and CAPPED refuses to arm regardless.
    if (fixMode === "proof-discrimination" && evidence.proofDiscrimination) {
      // NOT `reviewReport`: for this mode it was just overwritten with the live PR BODY (above) —
      // the worker's PROOF_AMENDMENT proposal lives only in its own transcript.
      amendProofs(evidence.proofDiscrimination);
    }
    // W1-T3557: RE-RESOLVE THE CONTRACT AT THE CURRENT PR HEAD, right before it is handed to the
    // reviewer — never earlier, so a strike's own push (just landed, just gone CI-green above)
    // is the head this resolves against, not some earlier round's. `opts.task` is the sweep-start
    // snapshot named in this task's rationale; `reviewTask` is what actually reaches the reviewer.
    let reviewTask = opts.task;
    if (deps.resolveTaskContractAtHead) {
      let resolvedContract: PlanCriteriaAtHeadResult | undefined;
      let resolveError: string | undefined;
      try {
        resolvedContract = await deps.resolveTaskContractAtHead(opts.prUrl, opts.taskId);
      } catch (e) {
        // A throwing resolver is exactly as unreadable as one that returns `undefined` — carry
        // the message into `resolveError` so the stand-down reason below names WHICH it was.
        resolveError = String((e as Error)?.message ?? e);
      }
      if (resolvedContract === undefined || resolvedContract.divergence !== undefined) {
        // UNREADABLE OR MISSING — never fall back to `opts.task`'s stale criteria (that is the
        // exact defect this task exists to close): stand the rung down, named, without ever
        // calling `deps.runReview`. A later fresh sweep re-dispatches and re-resolves.
        const reason = resolveError
          ? `fix rung: current PR-head task contract unreadable — resolver threw: ${resolveError}`
          : `fix rung: current PR-head task contract unreadable — ${resolvedContract?.divergence?.reason ?? "no contract returned"}`;
        deps.log("fix.stood_down", { site: "rung.head_contract", strikes, reason, taskId: opts.taskId });
        deps.say(`fix rung: standing down — ${reason}`);
        return { outcome: "stood_down", review, strikes, retriggers, reason, standDownReason: reason };
      }
      reviewTask = {
        ...opts.task,
        acceptance: resolvedContract.criteria,
        files: resolvedContract.taskDeclaredFiles,
      };
      deps.log("fix.head_contract_refreshed", {
        strike: strikes,
        criteria_count: resolvedContract.criteria.length,
        files_count: resolvedContract.taskDeclaredFiles?.length ?? 0,
        source: resolvedContract.source,
      });
    }
    review = await deps.runReview({
      owner: opts.reviewBase.owner,
      repo: opts.reviewBase.repo,
      prUrl: opts.prUrl,
      task: reviewTask,
      report: reviewReport,
      implementationReport: workerTranscript(fixResult),
      reportIsSubstitute: reviewReportIsSubstitute,
      reportSubstituteCause: reviewReportSubstituteCause,
      reviewInputBody,
      settingsFile: opts.settingsFile,
      config: opts.config,
      budgetUsd: opts.budgetUsd,
      log: deps.log,
      say: deps.say,
      account: deps.account,
      reviewerMount: opts.reviewBase.reviewerMount,
      reviewerClockBoundMs: opts.reviewerClockBoundMs,
      workerTelemetry: opts.workerTelemetry,
      headCheckoutDir: opts.reviewBase.headCheckoutDir,
      reviewerCodeFreshness: opts.reviewerCodeFreshness,
      ledgerPath: deps.ledgerPath,
      runId: opts.runId,
      openTaskIds: opts.openTaskIds,
    });
    progressReviewInputDigest = reviewInputBody === undefined ? undefined : reviewInputDigest(review.headSha, reviewInputBody);
    if (review.verdictWithheld) {
      deps.log("fix.stood_down", { site: "rung.reviewer_code_freshness", strikes, reason: review.verdictWithheld });
      return { outcome: "stood_down", review, strikes, retriggers, reason: review.verdictWithheld, standDownReason: review.verdictWithheld };
    }
    // W1-T100: a real review verdict now exists for THIS head — the CURRENT
    // strike stays review-mode from here. W1-T138: this can still flip back
    // to true on a LATER strike if ITS push regresses CI again (see above).
    noReviewYet = false;
    // W1-T2293: record THIS round's own substitute cause for the NEXT round's pre-strike gate —
    // `undefined` unless the report actually WAS a substitute (mirrors `reviewReportIsSubstitute`
    // itself; a throwing/absent `fetchPrBody` in body-coverage mode leaves both true).
    lastReportSubstituteCause = reviewReportIsSubstitute ? reviewReportSubstituteCause : undefined;
    // W1-T296: this round's OWN push produced the head this review just
    // evaluated — it becomes the reference the NEXT round's pre-strike
    // authorship check compares the live head against (sha lineage).
    rungOwnHeadSha = review.headSha;
    deps.log("fix.review", {
      round_id: roundId,
      strike: strikes,
      state: review.state,
      unmet: review.criteria.filter((c) => !c.met).length,
      head_sha: priorHeadSha,
    });

    if (review.decisionDisposition === "in_flight") {
      const reason = `identical review decision ${review.reviewDecisionDigest ?? "unknown"} is already in flight`;
      deps.log("fix.stood_down", { site: "rung.review_decision", strikes, reason });
      return { outcome: "stood_down", review, strikes, retriggers, reason, standDownReason: reason };
    }
    if (review.decisionDisposition === "conflict") {
      const digest = review.reviewDecisionDigest ?? "unknown";
      const issueUrl = await escalateWithJudge(
        {
          class: "BLOCKED",
          taskId: opts.taskId,
          runId: opts.runId,
          summary: `conflicting terminal review verdicts for ${digest} — ${opts.prUrl}`,
          detail:
            `Two evaluators produced contradictory states for the identical content-addressed review decision ` +
            `${digest}. Remudero held the effective state at failure and withheld merge. Evaluator provenance: ` +
            `${JSON.stringify(review.evaluatorProvenance ?? null)}. No prompt, transcript or credential is stored.`,
          options: [
            { label: "re-judge", detail: "inspect the two evaluator records and post an operator decision" },
            { label: "hold", detail: "leave the PR blocked until a material decision input changes" },
          ],
          recommendation: "re-judge",
        },
        { issues: deps.escalationIssues ?? deps.issues, ledgerPath: deps.ledgerPath, runId: opts.runId, judge: escalationJudge },
      );
      deps.log("review.decision_conflict_escalated", { strike: strikes, review_decision_digest: digest, issue_url: issueUrl });
      return { outcome: "escalated", review, strikes, retriggers, reason: "review_decision_conflict", issueUrl };
    }

    // W1-T168 (the #349/#360 stuck class): a review FALSE-BLOCK this rung
    // cannot fix by dispatching more code escalates for RE-JUDGMENT right
    // here — never as another silent strike toward exhaustion, and never
    // deferred to the generic exhaustion escalate() below (which would file
    // the wrong summary even on the strike this fired on).
    const falseBlockReason = detectReviewFalseBlock({ priorHeadSha, priorUnmetClaims, current: review });
    if (falseBlockReason && judgeIsStandIn) {
      const stop = await consultAtSite(falseBlockReason);
      if (stop.verdict === "unavailable") return { outcome: "handed_off", review, strikes, retriggers, reason: stop.reason };
      if (stop.verdict === "escalate") judgedStop = { loop: stop.loop, reason: stop.reason };
    }
    if (falseBlockReason && judgedStop === undefined) {
      progressRoundReason = falseBlockReason;
      deps.log("fix.false_block", { strike: strikes, reason: falseBlockReason, head_sha: review.headSha });
      continue;
    }
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
        return { outcome: "stood_down", review, strikes, retriggers, reason: preFalseBlockStandDown.reason, standDownReason: preFalseBlockStandDown.reason };
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
      const issueUrl = await escalateWithJudge(
        {
          class: "BLOCKED",
          taskId: opts.taskId,
          runId: opts.runId,
          // W1-T2799 (B): the two W1-T195 dedup dimensions this producer was the ONLY fix-rung
          // `escalate()` to omit — MEASURED against its siblings: the foreign-head producer passes
          // `headSha`, and the ci-log false-block, retrigger-exhaustion and strike-exhaustion
          // producers all pass BOTH. Omitting them is why four distinct heads collapsed into one
          // issue on #3889, and why the pre-strike gate above could not otherwise tell a new push
          // from a repeat. The `cause` expression is the IDENTICAL one the strike-exhaustion
          // producer below already uses, never a new derivation.
          headSha: review.headSha,
          cause: escalationCause(currentMergeConflict !== undefined, noReviewYet),
          // W1-T3579: the same 4th dedup dimension the pre-strike probe's key above already
          // carries — so a strike this task re-admits, if it needs to escalate again, opens a
          // REVISION-DISTINCT issue rather than silently appending to one filed against a since-
          // amended contract (design note (ii)).
          contractRevision: currentContractRevision,
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
        { issues: deps.escalationIssues ?? deps.issues, ledgerPath: deps.ledgerPath, runId: opts.runId, judge: escalationJudge },
      );
      deps.log("fix.exhausted", { strikes, issue_url: issueUrl, reason: "false_block" });
      deps.say(`fix rung: escalated (review false-block) — ${issueUrl}`);
      return { outcome: "escalated", review, strikes, retriggers, reason: "false_block", issueUrl };
    }
  }

  if (review.state === "success" && !proofDiscriminationStillNeedsRepair()) {
    deps.log("fix.resolved", { strikes, reason: "review passed" });
    deps.say(`fix rung: resolved after ${strikes} strike(s) — review now passes`);
    return { outcome: "fixed", review, strikes, retriggers, reason: "review passed" };
  }

  // W1-T7096: reached only through a judged stop at a former bound (`judgedStop`).
  // W1-T2403 SITE — THE RETRIGGER-CAP EXHAUSTION, DISTINCT FROM THE STRIKE-CAP EXHAUSTION BELOW.
  // The loop above can now stop for TWO different reasons: a real defect exhausting `strikeCap`
  // (unchanged, below) or a PERMANENTLY FAILING CHECK exhausting `retriggerCap` with ZERO real
  // strikes spent chasing it. Both escalate — nothing loops forever on either bound — but this
  // one names the check(s) that stayed red rather than an "unmet criteria" list, because no
  // criterion was ever judged unfixable; the check simply never turned green. The
  // `strikes < opts.strikeCap` guard means this branch is skipped when BOTH caps trip on the same
  // round — the ordinary strike-exhaustion escalate() below already covers that case correctly.
  if (retriggers >= retriggerCap && strikes < opts.strikeCap) {
    const preRetriggerStandDown = await fixRungStandDownReason(deps.readLiveState, opts.prUrl, "rung.retrigger_exhaustion", deps.log);
    if (preRetriggerStandDown) {
      deps.log("fix.stood_down", { site: "rung.retrigger_exhaustion", strikes, retriggers, reason: preRetriggerStandDown.reason });
      deps.say(`fix rung: standing down before retrigger-cap escalation — ${preRetriggerStandDown.reason}`);
      return {
        outcome: "stood_down",
        review,
        strikes,
        retriggers,
        reason: preRetriggerStandDown.reason,
        standDownReason: preRetriggerStandDown.reason,
      };
    }
    const staleCheckNames = Array.from(new Set([...everRedCiCheckNames, ...(currentCiFailures ?? []).map((f) => f.name)]));
    const issueUrl = await escalateWithJudge(
      {
        class: "BLOCKED",
        taskId: opts.taskId,
        runId: opts.runId,
        headSha: review.headSha,
        cause: escalationCause(currentMergeConflict !== undefined, noReviewYet),
        summary:
          staleCheckNames.length > 0
            ? `fix rung retrigger cap exhausted (${retriggers} retrigger(s), ${staleCheckNames.join(", ")} never went green) — ${opts.prUrl}`
            : `fix rung retrigger cap exhausted (${retriggers} retrigger(s)) — ${opts.prUrl}`,
        detail:
          `The fix rung (W1-T2403) dispatched ${retriggers} RETRIGGER-SHAPED round(s) on ${opts.branch} — every ` +
          `round's own new commit(s) either changed zero files or named a known-flaky re-trigger (see ` +
          `isRetriggerShapedCommit's own doc) — and the check(s) below never went green. ZERO real strike(s) ` +
          `were spent chasing this (of ${opts.strikeCap} available); the SEPARATE retrigger counter (cap ` +
          `${retriggerCap}) stopped it rather than a timer or an unbounded loop. Check(s) that stayed red:\n\n` +
          renderEscalationEvidence(staleCheckNames, (n) => `- ${n}`, staleCheckNames.length > 0),
        options: [
          {
            label: "hand-fix",
            detail: "investigate the named check directly — it is not a defect in this diff — and re-trigger it by hand once fixed.",
          },
          { label: "close", detail: "close the PR and re-scope the task if the check itself is permanently broken." },
        ],
        recommendation: "hand-fix",
      },
      { issues: deps.escalationIssues ?? deps.issues, ledgerPath: deps.ledgerPath, runId: opts.runId, judge: escalationJudge },
    );
    deps.log("fix.exhausted", { strikes, retriggers, issue_url: issueUrl, reason: "retrigger_cap_exhausted", ...(judgedStop ? { judged_loop: judgedStop.loop } : {}) });
    deps.say(`fix rung: retrigger cap exhausted (${retriggers} retrigger(s)) — escalated: ${issueUrl}`);
    return { outcome: "escalated", review, strikes, retriggers,
      reason: judgedStop?.judged ? `fix progress loop: ${judgedStop.loop} — ${judgedStop.reason}` : "retrigger_cap_exhausted", issueUrl };
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
    return { outcome: "stood_down", review, strikes, retriggers, reason: preEscalateStandDown.reason, standDownReason: preEscalateStandDown.reason };
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
  const issueUrl = await escalateWithJudge(
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
        ? `The CONFLICTED FIX RUNG (merge-conflict mode, W1-T94/W1-T106) spent ${strikes} bounded strike(s) ` +
          `on ${opts.branch} and the merge state is STILL dirty. Conflicting file(s):\n\n` +
          renderEscalationEvidence(currentMergeConflict?.files ?? [], (f) => `- ${f.path}`, currentMergeConflict !== undefined) +
          (consecutiveMergeRefusalReasons.length > 0 ? `\n\nConsecutive merge refusals:\n${consecutiveMergeRefusalReasons.map((reason, i) => `${i + 1}. ${reason}`).join("\n")}` : "")
        : noReviewYet
        ? `The blocked_ci FIX RUNG (ci-log mode, W1-T94/W1-T100/W1-T138) dispatched ${strikes} bounded fix worker(s) ` +
          `on ${opts.branch} and required checks are STILL red — no review has run yet. Failing check(s):\n\n` +
          renderEscalationEvidence(currentCiFailures ?? [], (f) => `- ${summarizeCiFailure(f)}`, currentCiFailures !== undefined) +
          (() => {
            const trajectory = renderCiTrajectoryLine(everRedCiCheckNames, (currentCiFailures ?? []).map((f) => f.name));
            return trajectory ? `\n\n${trajectory}` : "";
          })()
        : `The blocked_review FIX RUNG (W1-T76) dispatched ${strikes} bounded fix worker(s) on ` +
          `${opts.branch} and the review gate is STILL failing. Unmet criteria:\n\n` +
          renderEscalationEvidence(unmet, (c) => `- ${c.claim}\n  reason: ${c.reason}`, review.criteria.length > 0),
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
    { issues: deps.escalationIssues ?? deps.issues, ledgerPath: deps.ledgerPath, runId: opts.runId, judge: escalationJudge },
  );
  const exhaustionReason = stillConflicted
    ? "merge_conflict_unresolved"
    : noReviewYet
    ? "ci_never_green"
    : "review_still_failing";
  deps.log("fix.exhausted", { strikes, issue_url: issueUrl, reason: exhaustionReason, ...(judgedStop ? { judged_loop: judgedStop.loop } : {}) });
  deps.say(`fix rung: exhausted after ${strikes} strike(s) — escalated: ${issueUrl}`);
  return { outcome: "escalated", review, strikes, retriggers,
    reason: judgedStop?.judged ? `fix progress loop: ${judgedStop.loop} — ${judgedStop.reason}` : exhaustionReason, issueUrl };
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
  //
  // `route` joins them for the same reason `fetch` did: without it nothing can reach the effects
  // this command builds, so the one `buildSweepEffects` call site of the four that no test drives
  // stayed unexercised while the other three were graded. Omitted, it is `routeFix` and the
  // behaviour is byte-identical.
  //
  // `self` is the checkout's owner/repo, otherwise read from `origin`. A sandboxed checkout has no
  // origin remote, so a test that drives this verb end to end must be able to name the slug itself.
  deps: { config?: Config; fetch?: GhApiFetcher; route?: ReturnType<typeof fixCommandHelpers>["routeFix"]; self?: { owner: string; repo: string }; contributorAdmission?: AdmissionObserver } = {},

  host: FixCommandHost,
): Promise<number> {
  const { routeFix, requestedFixView } = fixCommandHelpers(host);
  const prArg = rest[0];
  // W1-T4077: `--requested` is the console's "Fix now". The operator asking for a fix IS the decision to try
  // again, so the strike count does not turn it into an escalation; every other refusal still applies.
  const badArg = unknownArgError("fix", rest.slice(1), ["--repo", "--admission-adopt-comment"], ["--requested"]);
  if (badArg) {
    console.error(badArg + "\n" + host.USAGE);
    return 2;
  }
  const prNumber = Number(prArg);
  if (!prArg || !Number.isInteger(prNumber) || prNumber <= 0) {
    console.error(`rmd fix: '${prArg ?? ""}' is not a valid PR number — usage: ${host.commandSyntax("fix")}\n` + host.USAGE);
    return 2;
  }

  const config = deps.config ?? loadConfig();
  const ledgerPath = ledgerPathFor(config);
  const self = deps.self ?? resolveOwnerRepo();
  const repo = flagValue(rest, "--repo") ?? self.repo;
  const owner = self.owner;
  const runId = `FIX-${systemClock.now()}`;
  const operatorRequested = rest.includes("--requested");
  const log = (step: string, extra: Record<string, unknown> = {}) =>
    appendLedger(ledgerPath, { run_id: runId, task_id: "FIX", step, lane: "fix", ...extra });
  const adoptionComment = flagValue(rest, "--admission-adopt-comment");
  await observeAdmissionDisposition(config.contributorAdmission, { owner, repo, prNumber }, config.root, log,
    adoptionComment === undefined ? undefined : Number(adoptionComment));
  await (deps.contributorAdmission ?? ((target, action) => observeContributorAdmission(config.contributorAdmission, target, action, log)))
    ({ owner, repo, prNumber }, "repair");

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
  const taskId = reviewTaskIdFromBody(raw.body ?? "");
  const reviewState = reviewStateFromRollup(raw.statusCheckRollup);
  // W1-T2299: same producer as buildOpenPrViews above — see OpenPrView.reviewVerdictPostedAt's doc.
  const reviewVerdictPostedAt = reviewVerdictPostedAtFromRollup(raw.statusCheckRollup);
  // W1-T103: same required-contexts gate as buildOpenPrViews — see
  // checksStateFromRollup's doc.
  const requiredContexts = ghRequiredStatusCheckContexts(owner, repo);
  const checksState = checksStateFromRollup(raw.statusCheckRollup, requiredContexts);
  const ciGateRequired = readCiGateRequiredChecks(repoRoot);
  const redRequiredChecks = redQualityGateNames(raw.statusCheckRollup, ciGateRequired);
  const falsePositive = ledger.some(row => row.step === CODE_SCANNING_FALSE_POSITIVE_STEP &&
    row.pr_number === raw.number && row.head_sha === raw.headRefOid);
  const failedCodeql = codeqlCheckFailed(raw.statusCheckRollup);
  const codeqlHeadAlerts = failedCodeql && !falsePositive
    ? (await runStepsAsync(hydrateCodeqlHeadAlertsSteps(owner, repo, [{ number: raw.number, headSha: raw.headRefOid }],
      deps.fetch ?? ((args, onRateLimit) => ghJsonAsync(args, undefined, onRateLimit)),
      undefined, (pr_number, reason) => log("fix.codeql_alerts_unreadable", { pr_number, head_sha: raw.headRefOid, reason })))).get(raw.number)
    : undefined;
  const pr: OpenPrView = {
    prNumber: raw.number,
    prUrl: raw.url,
    taskId,
    reviewState,
    reviewVerdictPostedAt,
    checksState,
    checksPendingSince: checksPendingSinceFromRollup(raw.statusCheckRollup, requiredContexts),
    unmetCriteria: reviewState === "failure" && taskId ? unmetFromLedger(ledger, taskId) : [],
    // W1-T440: same signal as buildOpenPrViews above — routeFix's deriveDisposition call
    // reads it via the SAME sweep.ts row 7.
    criteriaRecoverable: taskId !== undefined,
    priorStrikes: priorStrikesFor(ledger, taskId, currentStrikeRegimeFor(ledger, taskId), raw.headRefOid),
    repeatedFixRefusal: fixRoundTally(ledger, taskId, raw.headRefOid).repeatedRefusal,
    fixRefusalsAtHead: fixRoundTally(ledger, taskId, raw.headRefOid).refusals.length,
    strikeHistory: deriveStrikeHistory(ledger, taskId, raw.headRefOid),
    // superseded-by is a cross-PR sweep concern (which OTHER open PR credits the
    // same task) — out of scope for a single explicitly-named PR lookup.
    supersededBy: undefined,
    // W1-T2794 — likewise, and PERMANENTLY so here: `taskMergedBy` is stamped by the sweep's
    // `projectMergedTaskCandidates` pass over the whole open array. routeFix resolves ONE named PR
    // and never runs that pass, so this stays `undefined` — which the field's own doc defines as
    // UNKNOWN, leaving every disposition it feeds untouched.
    taskMergedBy: undefined,
    taskRetirement: undefined,
    // W1-T3585 — same reasoning as `taskMergedBy` directly above: `currentPlanIneligibilityReason`
    // needs a freshly-derived merged-task set this single-PR, operator-invoked bootstrap has no
    // board-wide projection to supply. `undefined` is the field's own defined "not proven
    // ineligible" state, so every disposition it feeds stays exactly what it was before this task.
    planResequenceIneligible: undefined,
    planFilingSource: undefined,
    lastActivityAt: raw.updatedAt,
    // W1-T1201: same age-clamp projection as buildOpenPrViews above — see RawOpenPr.createdAt's
    // doc for why this is `undefined` in the real gateway today.
    createdAt: raw.createdAt,
    headSha: raw.headRefOid,
    autoMergeArmed: raw.autoMergeRequest != null,
    reviewSummary: reviewState === "failure" ? reviewSummaryFromLedger(ledger, reviewLedgerKeyFor(taskId, raw.number), raw.url, raw.headRefOid) : undefined,
    // W1-T100: the ci-log fix mode's input — see buildOpenPrViews.
    ciFailures: checksState === "red" ? fetchCiFailures(owner, repo, raw.statusCheckRollup)
      : codeqlHeadAlerts ? [{ name: CODEQL_CHECK_NAME, logTail: "The CodeQL results check failed at this head." }] : undefined,
    codeqlHeadAlerts,
    redRequiredChecks,
  };

  const planPath =
    repo === self.repo ? join(repoRoot, "plan", "tasks.yaml") : join(config.root, "repos", repo, "plan", "tasks.yaml");
  let plan: Plan = { tasks: [], byId: new Map() };
  try {
    plan = loadPlan(planPath);
  } catch (e) {
    log("fix.plan.unavailable", { plan_path: planPath, error: String((e as Error)?.message ?? e) });
  }

  const effects = host.buildSweepEffects({
    productionProgressJudge: true,
    owner: owner,
    repo: repo,
    config: config,
    ledgerPath: ledgerPath,
    runId: runId,
    plan: plan,
    log: log,
    policy: DEFAULT_SWEEP_POLICY,
    // Already resolved above (or injected): do not make buildSweepEffects read origin a second time.
    localRepoName: self.repo,
  });
  const { outcome, reason } = await (deps.route ?? routeFix)(
    raw.state,
    operatorRequested ? requestedFixView(pr) : pr,
    { ...effects, ledgerLines: () => readLedgerLines(ledgerPath), log },
    DEFAULT_SWEEP_POLICY,
  );

  log(`fix.${outcome === "refused" ? "refused" : "disposed"}`, {
    pr_number: prNumber,
    task_id: taskId,
    outcome,
    reason,
    ...(operatorRequested ? { operator_requested: true } : {}),
  });
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
