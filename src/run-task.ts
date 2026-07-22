import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  architectModel,
  configPath as instanceConfigPath,
  fixStrikeCap,
  globalArtifactPath,
  loadConfig,
  notifyRecipient,
  softBudgetThreshold,
  userOverallLearningsHome,
  workerModel,
  workerShell,
  workerZdotdir,
  type Config,
} from "./lib/config.js";
import { buildWorkerEnv } from "./lib/env.js";
import { outputContractLines, renderAnchorBlock, commitMessageContractLines } from "./lib/compaction.js";
import type { RunResult } from "./lib/run-result.js";
export type { RunResult };
import { InitError, readClaudeJsonKeys, runInit } from "./lib/init.js";
import type { Tier, TierDetection } from "./lib/tier.js";
import { buildProjectInit, parseProjectInitArgs } from "./lib/project-init.js";
import {
  applyCuratedSelection,
  buildRundown,
  DEFAULT_MAX as DRAIN_DEFAULT_MAX,
  nextRunnable,
  plannedSequence,
  renderRundown,
  renderSummary,
  resumeCommand,
  runDrain,
  type CuratedSelection,
  type DrainOpts,
  type MergedSet,
  type OpenPrCheck,
} from "./lib/drain.js";
import {
  DEFAULT_POLL_INTERVAL_MS,
  daemonBoot,
  daemonExitCode,
  runDaemon,
  type DaemonOpts,
  type DaemonSummary,
} from "./lib/daemon.js";
import { makeTempDir, sweepStaleTempDirs, withTempDir } from "./lib/tmp.js";
import { DIGEST_LABEL, generateDigestLaunchdPlist, generateLaunchdPlist, launchdPlistPath } from "./lib/launchd.js";
import { buildDigest, sendDigest } from "./lib/digest.js";
import {
  escalate,
  ghIssueGateway,
  tryEscalate,
  type EscalationClass,
  type EscalationOption,
  type IssueGateway,
} from "./lib/escalate.js";
import { imessageChannel, notify } from "./lib/notify.js";
import { ghAlertGateway, pollAlerts, renderAlertsSummary } from "./lib/ops.js";
import { ghIssueListGateway, pollIssues, renderIssuesSummary } from "./lib/issues-intake.js";
import { loadManagedRepos, ManagedReposError } from "./lib/managed-repos.js";
import {
  captureFeedback,
  parseFeedbackAddArgs,
  readFeedbackEntry,
  setFeedbackStatus,
  FeedbackError,
  type FeedbackEntry,
} from "./lib/feedback.js";
import { ghTraceGateway, renderTraceChain, traceForward, traceReverse } from "./lib/trace.js";
import { ghIssueCloser } from "./lib/panel-actions.js";
import {
  buildServeServer,
  resolveServeHosts,
  resolveServePort,
  resolveServiceTokens,
  serviceTokensPath,
} from "./lib/serve.js";
import {
  buildGrillEscalation,
  decideTriage,
  diffCitesFeedback,
  nonPlanFilesInDiff,
  parseTriageArgs,
  parseTriageVerdict,
  triageCommitMessage,
  triagePrompt,
} from "./lib/triage.js";
import {
  applyPlanProposalCommit,
  decidePlanArchitect,
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
  parseDraftAttemptCache,
  parseDraftCache,
  parseProposalRegistry,
  pruneRatifiedProposals,
  proposalsNeedingDraft,
  ratifyTelemetry,
  reframeProposal,
  renderInbox,
  renderRatifyTelemetry,
  runDraftRung,
  summarizeInboxPoll,
  type DraftAttemptCache,
  type DraftCache,
  type DraftRungOutcome,
  type EvidenceAnchor,
  type InboxClassification,
  type Proposal,
  type ReadinessContext,
  type RatifyGateway,
} from "./lib/inbox.js";
import { parseUsage, type UsageSnapshot } from "./lib/headroom.js";
import {
  assertArchitectAboveWorker,
  buildGather,
  calibrationTable,
  codeFilesInDiff,
  loadMarker,
  parseLedger,
  probeGithubThrottle,
  renderGather,
  type ShippedGithub,
} from "./lib/retro.js";
import { regenerateOrientation } from "./lib/orientation.js";
import {
  buildPlanPrBody,
  ensureJudgeableBody,
  filingAcceptanceCriteria,
  regeneratePlanIndexAndCommit,
  regeneratePlanIndexFile,
} from "./lib/plan-pr-emitter.js";
import { appendLedger } from "./lib/ledger.js";
import {
  assertRunnable,
  loadPlan,
  loadPlanFromYaml,
  selectTask,
  type AcceptanceCriterion,
  type MergedResolver,
  type Plan,
  type Task,
} from "./lib/plan.js";
import { assertLintClean, changedTaskIds, lintTask, TaskLintError } from "./lib/task-linter.js";
import { loadMounts, mountsPath, resolveMount, type Mount } from "./lib/mounts.js";
import { loadSkillRegistry, renderSkillList, skillsDir, SkillError } from "./lib/skill.js";
import { ContainmentError, probeContainment } from "./lib/containment.js";
import { IsolationError, probeIsolation } from "./lib/isolation.js";
import {
  DEFAULT_KNOWLEDGE_BUDGET_CHARS,
  loadLayeredLearningsForTaskFiles,
  renderDoctrinePreamble,
  renderMatchedLearnings,
  selectLearnings,
} from "./lib/learnings.js";
import { assertProvenance, citation } from "./lib/provenance.js";
import { loadPlanIndex, renderPlanIndex } from "./lib/plan-index.js";
import {
  REVIEW_CONTEXT,
  applyVerdictStability,
  buildReviewPrompt,
  cappedAnnotation,
  cappedOverrideFromLedger,
  decideArmFromLedgerVerdict,
  fetchPrLifecycle,
  floorDegradedAnnotation,
  isTddStrict,
  judgeReview,
  keywordOnlyAnnotation,
  parseAcceptanceBlock,
  parseReviewerVerdicts,
  postReviewStatusGuarded,
  priorReviewVerdictFromLedger,
  resolveAutoMergeArm,
  reviewerOutcome,
  reviewerVerdictContract,
  reviewEvidenceStrength,
  reviewLedgerLegibilityFields,
  type CappedOverride,
  type CriterionVerdict,
  type ReviewVerdict,
} from "./lib/review.js";
import { buildDepReviewEscalation, decideDepReview } from "./lib/dep-review.js";
import { validateWorkerSettingsFile } from "./lib/settings.js";
import {
  buildBatchedGithub,
  deriveStatus,
  ghGateway,
  ghRequiredStatusCheckContexts,
  isDispatchBreakerTripped,
  projectPlan,
  readLedgerLines,
  type DeriveDeps,
  type GitHub,
  type StatusProjection,
} from "./lib/status.js";
import {
  DEFAULT_SWEEP_POLICY,
  checksStateFromRollup,
  deriveDisposition,
  isBlockedCi,
  renderClarificationQuestion,
  renderSweepSummary,
  runCreditBackfill,
  runSweep,
  strikeCapForAnswer,
  terminalStateReason,
  toQuestionEntry,
  type CiFailure,
  type ClarificationQuestion,
  type CreditCandidate,
  type FixDispatchEvidence,
  type LiveStateResult,
  type OpenPrView,
  type StrikeAttempt,
  type SweepDeps,
  type SweepPolicy,
} from "./lib/sweep.js";
import { applyCorrection } from "./lib/correct.js";
import {
  DEFAULT_PRUNE_GRACE_MS,
  appendQuestion,
  ghJson,
  parseDecisionRequest,
  parseQuestion,
  parseReconReport,
  parseReport,
  pruneStaleRuns,
  removeRunLock,
  renderWorkerSettings,
  spawnWorker,
  cacheTokenLedgerFields,
  workerLedgerFields,
  worktreeAdd,
  worktreeRemove,
  worktreesDir,
  writeRunLock,
  type SpawnWorkerArgs,
  type WorkerResult,
} from "./lib/worker.js";
import { acquireDrainLock, defaultIsPidAlive, DrainLockError, readDrainLock } from "./lib/drain-lock.js";
import { acquireInflightLock, InflightLockError, sweepStaleInflightLocks } from "./lib/inflight-lock.js";
import { classifyFailure, MAX_TRANSIENT_RETRIES, type FailureSignal } from "./lib/classify.js";
import { shouldRecordDecision } from "./lib/risk-score.js";
import {
  consumeStop,
  pauseDetail,
  requestPause,
  requestStop,
  resumeFleet,
  stopDetail,
} from "./lib/fleet-control.js";

// ── The proto-runner (WS-1 T1). Reads ONE tasks.yaml entry and runs the loop:
// recon → provenance-linted prompt → implement → PR → merge → verdict, ledgering
// every step. `rmd run-task <id>` is the single manual kick. No scheduler here.

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

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
    blob = execFileSync("git", ["-C", repoDir, "show", `origin/main:${relPath}`], { encoding: "utf8" });
  } catch (err) {
    throw new GitFetchError(`git show origin/main:${relPath} failed in ${repoDir}: ${String(err)}`);
  }
  const tmpDir = makeTempDir("plan"); // W1-T115: shared rmd- prefix (lib/tmp.ts), same try/finally as before
  try {
    const tmpFile = join(tmpDir, "tasks.yaml");
    writeFileSync(tmpFile, blob, "utf8");
    return { plan: loadPlan(tmpFile), staleDispatch };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
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
function armAutoMerge(prUrl: string, taskId: string | undefined): void {
  if (!taskId) {
    console.log(`automerge.ledger_refused (W1-T230): no task id resolvable for this PR — arming withheld: ${prUrl}`);
    return;
  }
  let headSha: string;
  try {
    const view = ghJson(["pr", "view", prUrl, "--json", "headRefOid"]) as { headRefOid: string };
    headSha = view.headRefOid;
  } catch (e) {
    console.log(
      `automerge.head_sha_unavailable (W1-T230): ${String((e as Error)?.message ?? e)} — arm withheld: ${prUrl}`,
    );
    return;
  }
  const config = loadConfig();
  const ledgerPath = join(config.root, "state", "ledger.ndjson");
  const prior = priorReviewVerdictFromLedger(readLedgerLines(ledgerPath), taskId);
  const decision = decideArmFromLedgerVerdict(prior, headSha);
  if (!decision.arm) {
    console.log(`automerge.ledger_refused (W1-T230): ${decision.reason} — ${prUrl}`);
    return;
  }
  try {
    execFileSync("gh", ["pr", "merge", prUrl, "--auto", "--squash", "--delete-branch"], {
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch {
    // On repos with zero required checks, GitHub may merge immediately on arm and
    // gh can report that as a non-zero "clean status" state. The poll below reads
    // the true PR state, so arming errors are informational, never fatal.
  }
}

/**
 * Ensure a PR body carries the `Remudero-Task: <id>` trailer. This is precedence
 * source (c) for deriveStatus AND it makes a run's provenance visible on GitHub.
 * Idempotent and non-fatal: whoever opened the PR (worker or fallback), the
 * orchestrator guarantees the trailer here.
 */
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
      reason:
        claimedBranch === null
          ? "claimed PR's head branch could not be resolved — failing closed rather than assumed owned"
          : `claimed PR's head branch "${claimedBranch}" is not this run's own branch "${ownBranch}"`,
    },
  };
}

interface GateOutcome {
  merged: boolean;
  reason: string;
}

/**
 * Poll a PR to a terminal gate decision. Returns merged only on state MERGED.
 * A red required check short-circuits to blocked; a timeout with checks still
 * pending is ALSO blocked (pending is never treated as pass).
 */
async function pollToGate(
  prUrl: string,
  log: (step: string, extra?: Record<string, unknown>) => void,
  maxIters = 60,
  everySec = 6,
): Promise<GateOutcome> {
  for (let i = 0; i < maxIters; i++) {
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
    if (i === 0 || i % 5 === 0) {
      log("pr.polling", {
        state: v.state,
        checks: roll.map((c) => `${c.name ?? c.context}:${c.conclusion ?? c.status ?? c.state}`),
      });
    }
    execFileSync("sleep", [String(everySec)]);
  }
  return { merged: false, reason: "timeout waiting for checks (pending treated as blocked)" };
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
 * Poll the PR's `ci` check to a terminal state BEFORE the review runs (Standing
 * rule 4: the reviewer judges ACCEPTANCE only once the code is proven to typecheck
 * and its tests pass). Returns "green" on ci success, "red" on any red conclusion,
 * "timeout" if ci never resolves — pending is never treated as pass. The scan
 * ignores `remudero-review`'s OWN pinned status ({@link ciGateFromRollup}) so a
 * body-only fix strike (unchanged head sha) is never blocked by the review
 * verdict it is itself about to replace.
 */
async function waitForCiGreen(
  prUrl: string,
  log: (step: string, extra?: Record<string, unknown>) => void,
  maxIters = 60,
  everySec = 6,
): Promise<"green" | "red" | "timeout"> {
  for (let i = 0; i < maxIters; i++) {
    const v = ghJson(["pr", "view", prUrl, "--json", "statusCheckRollup"]) as {
      statusCheckRollup?: RollupEntry[];
    };
    const state = ciGateFromRollup(v.statusCheckRollup);
    if (state === "red") return "red";
    if (state === "green") return "green";
    const ci = (v.statusCheckRollup ?? []).find((c) => (c.name ?? c.context) === "ci");
    if (i === 0 || i % 5 === 0) log("ci.polling", { ci: String(ci?.conclusion ?? ci?.status ?? "pending") });
    execFileSync("sleep", [String(everySec)]);
  }
  return "timeout";
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
  task: { id: string; acceptance?: AcceptanceCriterion[] };
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
}): Promise<ReviewVerdict & { headSha: string; reviewerOutcome: string }> {
  const { owner, repo, prUrl, task, report, log, say } = args;
  const view = ghJson(["pr", "view", prUrl, "--json", "headRefOid"]) as { headRefOid: string };
  const headSha = view.headRefOid;
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
  });

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
    description: verdict.summary,
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
  const unmetClaims = unmet.map((c) => c.claim);
  const reasons = unmet.map((c) => c.reason);
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
  });
  if (verdict.capped) {
    say(cappedAnnotation(proofExec.length));
  } else if (verdict.floorDegraded) {
    say(floorDegradedAnnotation(proofExec.length));
  }
  if (verdict.keywordOnly && !verdict.capped) {
    say(keywordOnlyAnnotation());
  }
  if (verdict.state !== "success" && (unmetClaims.length > 0 || verdict.testTheater)) {
    // Post the full unmet list as a PR comment so a blocked PR names its gap in one
    // place a human (or the next run) reads. Best-effort — never blocks the verdict.
    const body =
      `**remudero-review=failure** — the following acceptance ${unmetClaims.length === 1 ? "criterion is" : "criteria are"} unmet:\n\n` +
      unmetClaims.map((c, i) => `${i + 1}. ${c}\n   - ${unmet[i].reason}`).join("\n") +
      (verdict.testTheater ? `\n\n_Also: test theater — added tests assert nothing._` : "") +
      `\n\nAdd the missing work (or escalate). Do NOT edit the acceptance criteria to match the diff.`;
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

/** The three known fix-rung failure modes. See the taxonomy note above. */
export type FixMode = "reviewer-unmet" | "body-coverage" | "ci-log" | (string & {});

/**
 * The block evidence a fix dispatch derives its MODE from. Exactly one shape
 * is populated by any real caller today: `review` for a `blocked_review`
 * verdict (reviewer-unmet / body-coverage — the rung's live callers), `review`
 * left `undefined` for a bare `blocked_ci` block with no review verdict at all
 * (ci-log — a future caller; the sweep's own module doc names this task as its
 * prerequisite). `ciFailures` carries the ci-log mode's input either way.
 */
export interface FixEvidence {
  review?: { unmetCriteria: CriterionVerdict[]; summary: string };
  ciFailures?: CiFailure[];
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
 *   1. ci-log         — no review verdict at all (`review` undefined): the
 *                        failing signal IS the CI log, never a reviewer verdict.
 *   2. body-coverage   — every unmet criterion's reason is a keyword-coverage
 *                        gap ("matched N/M proof keywords") and NONE was an
 *                        OBSERVED `executed_fail` (an actual failed run always
 *                        means real code broke — never treat that as body-only,
 *                        the #157/#143 lesson).
 *   3. reviewer-unmet  — the default: a real reviewer-computed unmet set
 *                        (W1-T76, unchanged).
 */
export const FIX_MODE_RULES: readonly FixModeRule[] = [
  {
    mode: "ci-log",
    when: (e) => e.review === undefined,
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
 * at all. Both `resume` (round 1) and `fresh` (round 2+) rounds get the
 * identical full-set framing for their mode.
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
    `branch (only a run-<taskId>-<epochMs> head is creditable). \`git push origin HEAD\` (no`,
    `-u) when done — never force-push. Your PR body must substantiate EVERY task acceptance`,
    `criterion, not only the ones fixed here — the review floor judges the body against the`,
    `FULL criteria set. End with a REPORT whose last line is exactly: PR_URL: <url>`,
  ];

  if (mode === "ci-log") {
    const failures = opts.evidence.ciFailures ?? [];
    const rendered =
      failures.length > 0
        ? failures.map((f, i) => `${i + 1}. check: ${f.name}\n   log tail:\n${f.logTail}`).join("\n\n")
        : "(no failing check detail was captured — re-check `gh pr checks` for the current state.)";
    return [
      header,
      ...constraintBlock,
      `Required CI check(s) are FAILING and NO review has run yet (a review needs green CI`,
      `first) — the failing signal here IS the CI log, not a reviewer verdict. Your target is`,
      `making CI GREEN on the SAME branch; do not expand scope beyond what the failing`,
      `check(s) below require.`,
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
  /** Set only when `outcome === "escalated"`. */
  issueUrl?: string;
  /**
   * W1-T177: set only when `outcome === "stood_down"` — the freshly observed
   * terminal-state reason (from {@link terminalStateReason}) that stopped a
   * strike from being spent, or the exhaustion escalate() from firing, on a
   * PR that no longer carries a live block.
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
 * W1-T177: resolve a stand-down reason from an OPTIONAL live-state reader —
 * shared by the fix rung's two internal checks (top of round; immediately
 * before the exhaustion escalate()) so both read via the SAME fail-open
 * contract. `undefined` (no reader wired, or a failed/indeterminate read)
 * means "proceed exactly as before this check existed" — standing down fires
 * ONLY on a positive, freshly-observed terminal reading. A FAILED/
 * INDETERMINATE read (`ok:false`) is explicitly LEDGERED here (never a
 * silent swallow) so an unreadable state is legible on the ledger even
 * though it never halts anything — the read failure itself is observable,
 * distinct from an ordinary un-wired site (which never calls `log` at all).
 */
async function fixRungStandDownReason(
  readLiveState: ((prUrl: string) => LiveStateResult | Promise<LiveStateResult>) | undefined,
  prUrl: string,
  site: string,
  log: (step: string, extra?: Record<string, unknown>) => void,
): Promise<string | undefined> {
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
  return terminalStateReason(live.state);
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
  task: { id: string; title: string; acceptance?: AcceptanceCriterion[] };
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

  while (review.state !== "success" && strikes < opts.strikeCap) {
    // W1-T177 SITE (i) — TERMINAL-STATE CHECK before `strikes++`: the ONLY
    // point that stops a strike being SPENT on a PR that went terminal
    // (merged/closed) since the previous round. Read FRESH every round —
    // never the caller's snapshot.
    const preStrikeStandDown = await fixRungStandDownReason(deps.readLiveState, opts.prUrl, "rung.strike", deps.log);
    if (preStrikeStandDown) {
      deps.log("fix.stood_down", { site: "rung.strike", strike: strikes + 1, reason: preStrikeStandDown });
      deps.say(`fix rung: standing down before strike ${strikes + 1} — ${preStrikeStandDown}`);
      return { outcome: "stood_down", review, strikes, standDownReason: preStrikeStandDown };
    }
    strikes++;
    const round: "resume" | "fresh" = strikes === 1 ? "resume" : "fresh";
    const unmet = review.criteria.filter((c) => !c.met);
    const evidence: FixEvidence = noReviewYet
      ? { ciFailures: currentCiFailures, constraint: opts.constraint }
      : { review: { unmetCriteria: unmet, summary: review.summary }, constraint: opts.constraint };
    const prompt = renderFixPrompt({
      task: opts.task,
      round: strikes,
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
    deps.log("fix.dispatch", { strike: strikes, strike_cap: opts.strikeCap, unmet_count: unmet.length, round, mode: deriveFixMode(evidence), verdict_regime: verdictRegime });
    deps.say(
      noReviewYet
        ? `fix rung: strike ${strikes}/${opts.strikeCap} (${round}) — dispatching ONE ci-log fix worker for ` +
          `${(currentCiFailures ?? []).length} failing check(s)`
        : `fix rung: strike ${strikes}/${opts.strikeCap} (${round}) — dispatching ONE fix worker for ` +
          `${unmet.length} unmet criteri${unmet.length === 1 ? "on" : "a"}`,
    );

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
    };

    const fixResult = deps.account(await deps.spawn(fixArgs));
    sessionToResume = fixResult.sessionId;
    deps.log("fix.done", {
      strike: strikes,
      round,
      session_id: fixResult.sessionId,
      subtype: fixResult.subtype,
      cost_usd: fixResult.costUsd,
      num_turns: fixResult.numTurns,
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

    review = await deps.runReview({
      owner: opts.reviewBase.owner,
      repo: opts.reviewBase.repo,
      prUrl: opts.prUrl,
      task: opts.task,
      report: [fixResult.text, fixResult.blocks.join("\n")].join("\n"),
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
    });
    // W1-T100: a real review verdict now exists for THIS head — the CURRENT
    // strike stays review-mode from here. W1-T138: this can still flip back
    // to true on a LATER strike if ITS push regresses CI again (see above).
    noReviewYet = false;
    deps.log("fix.review", {
      strike: strikes,
      state: review.state,
      unmet: review.criteria.filter((c) => !c.met).length,
    });
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
    deps.log("fix.stood_down", { site: "rung.exhaustion", strikes, reason: preEscalateStandDown });
    deps.say(`fix rung: standing down before escalation — ${preEscalateStandDown}`);
    return { outcome: "stood_down", review, strikes, standDownReason: preEscalateStandDown };
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
  const issueUrl = escalate(
    {
      class: "BLOCKED",
      taskId: opts.taskId,
      runId: opts.runId,
      summary: noReviewYet
        ? `blocked_ci fix rung exhausted (${strikes} strike(s), checks never went green) — ${opts.prUrl}`
        : `blocked_review fix rung exhausted (${strikes} strike(s)) — ${opts.prUrl}`,
      detail: noReviewYet
        ? `The blocked_ci FIX RUNG (ci-log mode, W1-T94/W1-T100/W1-T138) dispatched ${strikes} bounded fix worker(s) ` +
          `on ${opts.branch} and required checks are STILL red — no review has run yet. Failing check(s):\n\n` +
          (currentCiFailures ?? []).map((f) => `- ${summarizeCiFailure(f)}`).join("\n")
        : `The blocked_review FIX RUNG (W1-T76) dispatched ${strikes} bounded fix worker(s) on ` +
          `${opts.branch} and the review gate is STILL failing. Unmet criteria:\n\n` +
          unmet.map((c) => `- ${c.claim}\n  reason: ${c.reason}`).join("\n"),
      options: noReviewYet
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
    billing_mode: "subscription";
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
      billing_mode: "subscription",
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
    billing_mode: "subscription";
    reason: string;
    model: string;
    effort: string;
    tokens: WorkerResult["tokens"];
    /** W1-T35 named columns — see {@link cacheTokenLedgerFields}. */
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
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
 */
export function noPrVerdict(r: WorkerResult, costUsd: number, stage: string): NoPrVerdict {
  return {
    verdict: "no_pr",
    ledger: {
      verdict: "no_pr",
      stage,
      subtype: r.subtype,
      num_turns: r.numTurns,
      cost_usd: costUsd,
      billing_mode: "subscription",
      reason: "worker completed without opening a PR",
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

function reconObservedToContext(recon: WorkerResult, taskId: string): string {
  const parsed = parseReconReport([recon.text, recon.blocks.join("\n")].join("\n"));
  const observed = parsed?.observed ?? "";
  const lines = observed
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  // Each OBSERVED line becomes a cited CONTEXT claim (provenance from recon).
  return lines.map((l) => `- ${l} ${citation(`recon#${taskId}`)}`).join("\n");
}

/**
 * Render the RECON worker's prompt (W1-T37, MASTER-PLAN §8A Tier 2): the fixed read-only recon
 * instructions, plus the generated PLAN INDEX in place of the plan body. The plan (MASTER-PLAN.md)
 * is NOT shipped to workers — `planIndexBlock` (from {@link renderPlanIndex}) is a compact list of
 * section headings + one-line summaries + a grep hint, so a recon worker that needs a specific
 * section's detail can retrieve it itself (`grep -n '<heading>' MASTER-PLAN.md`) instead of every
 * run paying to carry the whole ~1900-line document. `planIndexBlock` is `""` when no index is
 * committed yet (a fresh checkout before the first `npm run plan-index`) — recon still runs, just
 * without the pointer; correctness never depends on the index being present.
 */
export function renderReconPrompt(planIndexBlock: string): string {
  return [
    "You are a RECON worker. Do NOT modify anything. Inspect the current git " +
      "repository read-only (git remote -v, git log --oneline -5, ls). Output one report:\n" +
      "RECON REPORT\nOBSERVED: <commands + key output>\nINFERRED: <conclusions>\n" +
      "COULDN'T-VERIFY: <unconfirmed>",
    planIndexBlock,
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
 */
export function renderImplementPrompt(
  task: Task,
  reconContext: string,
  runId: string,
  matchedLearnings = "",
): string {
  const contextClaims = (task.context ?? [])
    .map((c) => `- ${c.claim} ${citation(c.src)}`)
    .join("\n");
  const body = (task.prompt ?? task.title)
    .split("${RUN_ID}").join(runId)
    .split("${TASK_ID}").join(task.id);

  return [
    "# CONTEXT",
    renderDoctrinePreamble(),
    contextClaims,
    reconContext,
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
    /** Injectable worker-spawn — behavioral tests (W1-T20c criterion 5) count calls to prove
     *  a linter-failing task NEVER reaches a spawn. Default: the real {@link spawnWorker}. */
    spawn?: typeof spawnWorker;
    /** Injectable GitHub gateway for the status projection — lets a behavioral test drive the
     *  dispatch path without a network round-trip. Default: the real {@link ghGateway}. */
    github?: GitHub;
  } = {},
): Promise<RunResult> {
  const config = opts.config ?? loadConfig();
  const spawn = opts.spawn ?? spawnWorker;
  const planPath = opts.planPath ?? join(repoRoot, "plan", "tasks.yaml");
  const ledgerPath = join(config.root, "state", "ledger.ndjson");
  const owner = resolveOwner();

  const runId = `${taskId}-${Date.now()}`;
  const log = (step: string, extra: Record<string, unknown> = {}) =>
    appendLedger(ledgerPath, { run_id: runId, task_id: taskId, step, ...extra });
  const say = (msg: string) => console.log(`\n### [${taskId}] ${msg}`);

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
  const projection = projectPlan(
    plan,
    { ledgerPath: join(config.root, "state", "ledger.ndjson"), github: opts.github ?? ghGateway(owner, task.repo) },
    statusPath,
  );
  const isMerged = (t: Task): boolean => projection.get(t.id)?.merged ?? false;
  assertRunnable(plan, task, isMerged); // refuse unmerged deps / blocked / verify:human

  // ── §5C LAYER A: deterministic task linter, FAIL-CLOSED pre-dispatch guard
  // (MASTER-PLAN §5C). Four malformed tasks (W1-T6, W1-T9, W1-T12) reached a
  // worker and burned budget before a human noticed the pattern; this refuses a
  // linter-failing task BEFORE the inflight lock is even taken — no lock, no
  // worktree, no worker ever spawns. `rmd drain` dispatches every task through
  // this same `runTask` path, so this ONE call site gates both entry points.
  try {
    assertLintClean(task);
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
  // holder); a stale (dead-pid) lock ⇒ reclaim. Released on EVERY terminal path via the
  // finally below, so a crash never leaves a permanent stale lock.
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

  // ── MOUNT RESOLUTION (§9). The (task_type × risk) routing table OWNS the
  // model/effort/max_turns a run rides — never a hardcoded literal (the W1-T6
  // defect: a dead mounts.yaml + a hardcoded 60-turn ceiling, see DIAGNOSIS.md). Resolve
  // ONCE here and FAIL LOUD on a miss: a missing mount is a config gap, never a
  // silent fallback to some default number. loadMounts throws on a bad/absent table;
  // resolveMount throws on an unrouted (type × risk).
  // The table is a COMMITTED repo artifact (§9, golden-gated), so read it from the
  // repo checkout (repoRoot), NOT the workspace root (config.root = ~/Remudero, which
  // holds worktrees/state, not .remudero/mounts.yaml).
  const mountsTable = loadMounts(mountsPath(repoRoot));
  const mount: Mount = resolveMount(mountsTable, task.type, task.risk);
  // The fresh advisory reviewer (runReview, below) is its OWN mount-governed phase,
  // keyed by task_type="reviewer" — distinct from `mount` above (this task's own
  // implement/recon/etc. work) and from task_type="review" (a plan task whose own
  // type happens to be "review"). W1-T63/P10: previously ungoverned (an undeclared
  // 12-turn cap, no model/effort), it walled `error_max_turns` on every
  // substantive code PR.
  const reviewerMount: Mount = resolveMount(mountsTable, "reviewer", task.risk);
  // The blocked_review FIX RUNG's mount (W1-T76, absorbs P21) — its own
  // task_type="fix" row (§9), distinct from `mount` (the original implement
  // attempt). Resolved once here, alongside every other mount, even though it
  // is only USED if the review gate ever fails — a fix spawn must never ride
  // an undeclared literal any more than the reviewer used to (W1-T63/P10).
  const fixMount: Mount = resolveMount(mountsTable, "fix", task.risk);
  log("run.start", {
    repo: task.repo,
    type: task.type,
    risk: task.risk,
    budget_usd: budgetUsd,
    soft_threshold_usd: softThresholdUsd,
    mount: { model: mount.model, effort: mount.effort, max_turns: mount.maxTurns, context_budget: mount.contextBudget },
  });
  say(`run ${runId} — target ${owner}/${task.repo} · mount ${mount.model}/${mount.effort} · ${mount.maxTurns} turns (${task.type}×${task.risk})`);

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
    });
    costUsd += probe.costUsd; // meter the probe spawn (notional; the ledger has it)
    say(`containment preflight PASSED — ${probe.reason}`);
  } catch (e) {
    if (e instanceof ContainmentError) {
      log("verdict", {
        verdict: "blocked_containment",
        reason: e.message,
        cost_usd: costUsd,
        billing_mode: "subscription",
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
    });
    costUsd += isoProbe.costUsd; // meter the probe spawn (notional; the ledger has it)
    say(`isolation preflight PASSED — ${isoProbe.reason}`);
  } catch (e) {
    if (e instanceof IsolationError) {
      log("verdict", {
        verdict: "blocked_isolation",
        reason: e.message,
        cost_usd: costUsd,
        billing_mode: "subscription",
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

  const branch = `run-${runId}`;
  const worktreePath = join(worktreesDir(config), branch);
  worktreeAdd(repoDir, worktreePath, branch, "origin/main");
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
    const recon = account(
      await spawn({
        cwd: worktreePath,
        permissionMode: "bypassPermissions",
        settingsFile,
        maxTurns: 8, // recon is read-only + bounded; turns stay tight here.
        maxBudgetUsd: budgetUsd, // dollars are the real backstop (WS-0 knob a).
        config,
        prompt: renderReconPrompt(planIndexBlock),
      }),
    );
    log("recon.done", {
      session_id: recon.sessionId,
      cost_usd: recon.costUsd,
      num_turns: recon.numTurns,
      subtype: recon.subtype,
      // W1-T6: every worker call ledgers the standard telemetry shape.
      ...workerLedgerFields(recon),
    });
    const reconFail = failOnWorkerError(recon, "recon");
    if (reconFail) return reconFail;

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
    const { entries: learnings, globalRefusedReason } = loadLayeredLearningsForTaskFiles(
      {
        projectDir: learningsDir,
        userOverallDir: userOverallLearningsHome(config),
        globalArtifactPath: globalArtifactPath(config),
      },
      task.files,
    );
    const { selected, dropped } = selectLearnings(learnings, task.files, DEFAULT_KNOWLEDGE_BUDGET_CHARS);
    // VOLATILE (Tier 1) — deliberately NOT combined with the stable doctrine
    // preamble here: renderImplementPrompt places this LAST in the CONTEXT
    // block (cache-aware ordering, W1-T35) so a growing corpus can never bust
    // the cache for the stable/per-task bytes that precede it.
    const matchedLearnings = renderMatchedLearnings(selected);
    log("learnings.injected", {
      matched: selected.length,
      dropped: dropped.map((d) => d.id),
      budget_chars: DEFAULT_KNOWLEDGE_BUDGET_CHARS,
      global_refused_reason: globalRefusedReason,
    });

    // ── Render + provenance-lint the prompt.
    const reconContext = reconObservedToContext(recon, taskId);
    const prompt = renderImplementPrompt(task, reconContext, runId, matchedLearnings);
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
        await spawnWorker({
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
        billing_mode: "subscription",
        reason: `repeated transient API error across ${MAX_TRANSIENT_RETRIES} retries — not a task failure`,
      });
      say(`verdict: blocked_transient — repeated transient API error, not a task failure`);
      return { taskId, runId, merged: false, costUsd, verdict: "blocked_transient" };
    }
    const implFail = failOnWorkerError(impl, "implement");
    if (implFail) return implFail;

    const fullText = (r: WorkerResult) => [r.text, r.blocks.join("\n")].join("\n");

    // ── DECISION_REQUEST → auto-choose RECOMMENDED → resume (§4).
    const decision = parseDecisionRequest(fullText(impl));
    if (decision && !parseReport(fullText(impl))?.prUrl) {
      const chosen = decision.recommended ?? decision.options[0] ?? "(first option)";
      // W1-T32: DECISIONS.md hygiene. Every DECISION_REQUEST is auto-chosen and
      // ledgered — that never changes — but only decisions worth a human's
      // future attention (risk >= medium, or an explicit reversibility
      // caveat) get PROMOTED to the durable, human-read record. A trivial
      // filename pick stays ledger-only instead of burying real decisions.
      const recordVerdict = shouldRecordDecision(decision);
      if (recordVerdict.record) {
        appendFileSync(
          join(repoRoot, "DECISIONS.md"),
          `\n## ${new Date().toISOString()} — ${taskId} (${runId})\n` +
            `- Options: ${decision.options.join(" | ")}\n` +
            `- Chosen (RECOMMENDED, auto): ${chosen}\n` +
            `- Risk: ${recordVerdict.band} (${recordVerdict.reason})\n` +
            `- Rollback: revert the PR.\n`,
        );
      }
      log("decision.autochoose", { chosen, recorded: recordVerdict.record, risk_band: recordVerdict.band });
      say(
        `DECISION_REQUEST auto-chose: ${chosen} (${recordVerdict.record ? "recorded in DECISIONS.md" : "ledger-only, " + recordVerdict.band + " risk"})`,
      );
      impl = account(
        await spawnWorker({
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
    if (!prUrl && commitsAhead(worktreePath, "origin/main") === 0) {
      const v = noPrVerdict(impl, costUsd, "implement");
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
      say("fallback: pushing branch from orchestrator (outside sandbox)");
      execFileSync("git", ["-C", worktreePath, "push", "origin", "HEAD"], { stdio: "inherit" });
    }
    if (!prUrl) {
      const out = execFileSync(
        "gh",
        ["pr", "create", "--repo", `${owner}/${task.repo}`, "--base", "main", "--head", branch, "--fill"],
        { encoding: "utf8" },
      );
      prUrl = out.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/)?.[0];
    }
    if (!prUrl) {
      log("verdict", { verdict: "failed", reason: "no PR opened", cost_usd: costUsd });
      return { taskId, runId, merged: false, costUsd, verdict: "failed" };
    }
    // RUN-OWNERSHIP GUARD (W1-T62) — before ANY side effect touches this PR, assert
    // it is actually this run's own PR (the false-merged inversion backstop; see
    // checkPrOwnership). Fails closed and named on mismatch; the PR is left untouched.
    const ownership = checkPrOwnership(prUrl, branch, ghPrHeadGateway(), costUsd);
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
        billing_mode: "subscription",
      });
      say(`verdict: blocked_ci (ci ${ci}) — PR left OPEN: ${prUrl}`);
      return { taskId, runId, prUrl, merged: false, costUsd, verdict: "blocked_ci" };
    }
    let review = await runReview({
      owner,
      repo: task.repo,
      prUrl,
      task,
      report: fullText(impl),
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
              execFileSync("git", ["-C", wt, "push", "origin", "HEAD"], { stdio: "ignore" });
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
          billing_mode: "subscription",
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
          billing_mode: "subscription",
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
    const cappedOverride = review.capped ? cappedOverrideFromLedger(readLedgerLines(ledgerPath), taskId) : undefined;
    const armDecision = resolveAutoMergeArm(review, tddStrict, cappedOverride, (s, extra) => log(s, extra));
    if (!armDecision.arm) {
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
        billing_mode: "subscription",
      });
      say(`verdict: blocked — CAPPED verdict, escalated: ${issueUrl}`);
      return { taskId, runId, prUrl, merged: false, costUsd, verdict: "blocked" };
    }

    // ── ARM auto-merge, then POLL to the gate (W1-T1B).
    // The runner NEVER force-merges: it arms GitHub auto-merge on the PR it just
    // opened against main, then observes. GitHub merges only when the required
    // check is green. If checks go red or the poll times out, the PR is LEFT
    // OPEN and the verdict is blocked_ci — pending is treated as blocked, never
    // as pass. No Action arms a PR; only this code, only on PRs it opened.
    armAutoMerge(prUrl, taskId);
    log("automerge.armed", {});
    const outcome = await pollToGate(prUrl, (s, extra) => log(s, extra));

    if (outcome.merged) {
      log("pr.merged", { state: "MERGED" });
      worktreeRemove(repoDir, worktreePath);
      log("worktree.remove", {});
      log("verdict", { verdict: "merged", pr_url: prUrl, cost_usd: costUsd, billing_mode: "subscription" });
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
      billing_mode: "subscription",
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
// ────────────────────────────────────────────────────────────────────────────

/** Injected git operations for {@link materializeReviewWorktree} — real
 * callers use the module's own `execFileSync` calls; tests fake them so
 * materialization success/failure is a unit fixture, no real git/network
 * involved. */
export interface ReviewWorktreeDeps {
  fetch: (repoDir: string) => void;
  addWorktree: (repoDir: string, worktreePath: string, branch: string) => void;
}

const realReviewWorktreeDeps: ReviewWorktreeDeps = {
  fetch: (repoDir) => execFileSync("git", ["-C", repoDir, "fetch", "origin", "--quiet"], { stdio: "pipe" }),
  addWorktree: (repoDir, worktreePath, branch) => {
    execFileSync("git", ["-C", repoDir, "worktree", "add", worktreePath, `origin/${branch}`], { stdio: "pipe" });
    execFileSync("git", ["-C", worktreePath, "checkout", "-B", branch, `origin/${branch}`], { stdio: "pipe" });
  },
};

/**
 * Materialize a throwaway worktree at a PR's head branch so `rmd review` can
 * execute whitelisted proofs exactly like the automated fix rung does.
 * Returns the worktree path on success; `undefined` on ANY failure (network,
 * disk, a detached/deleted head) — the caller then falls back to a
 * keyword-only, CAPPED verdict (acceptance criterion 5), never a thrown
 * command reaching the operator. Teardown is the CALLER's responsibility
 * (`reviewCommand`'s `finally`), so a throw from `runReview` itself still
 * tears the worktree down (criterion 6) — this function only ever creates.
 */
export function materializeReviewWorktree(
  config: Config,
  repoDir: string,
  prNumber: number,
  headRefName: string,
  deps: ReviewWorktreeDeps = realReviewWorktreeDeps,
): string | undefined {
  const worktreePath = join(worktreesDir(config), `review-PR${prNumber}-${Date.now()}`);
  try {
    deps.fetch(repoDir);
    deps.addWorktree(repoDir, worktreePath, headRefName);
    return worktreePath;
  } catch {
    return undefined;
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

async function reviewCommand(prArg: string, rest: string[] = []): Promise<number> {
  // `--repo <name>` or `--repo <owner>/<name>` lets the runner post remudero-review to a
  // repo OTHER than this checkout (e.g. remudero-sandbox for the daemon's live commissioning,
  // W1-T12d). Without it, resolveOwnerRepo() pins to repoRoot's origin (the main repo) and
  // `gh pr view` resolves the PR in the CWD — so a sandbox PR could never be gated. The lib
  // layer (runReview / postReviewStatus) already takes owner+repo; only the CLI was pinned.
  const { owner, repo } = resolveReviewTarget(resolveOwnerRepo(), rest);
  const slug = `${owner}/${repo}`;
  const view = ghJson([
    "pr", "view", prArg, "--repo", slug, "--json", "headRefOid,headRefName,body,url,number",
  ]) as {
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
  const taskId = body.match(/Remudero-Task:\s*(\S+)/)?.[1];
  if (taskId) {
    try {
      const plan = loadPlan(join(repoRoot, "plan", "tasks.yaml"));
      const t = plan.byId.get(taskId);
      if (t?.acceptance?.length) {
        criteria = t.acceptance;
        source = `plan/tasks.yaml task ${taskId} (${criteria.length} criteria)`;
      }
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

  const config = loadConfig();
  const ledgerPath = join(config.root, "state", "ledger.ndjson");
  const runId = `review-PR${view.number}-${Date.now()}`;
  const log = (step: string, extra: Record<string, unknown> = {}) =>
    appendLedger(ledgerPath, { run_id: runId, task_id: taskId ?? `PR-${view.number}`, step, ...extra });

  console.log(`### rmd review PR #${view.number} — criteria from ${source}`);

  // W1-T185 (Gap 2): materialize a throwaway worktree at the PR head so
  // whitelisted proofs actually EXECUTE on this manual path, matching what
  // the automated fix rung observes for the same PR/proofs (acceptance
  // criterion 4). On ANY failure this returns undefined and the review falls
  // back to keyword-only — EXPLICITLY marked (criterion 5), never silently.
  const worktreePath = materializeReviewWorktree(config, repoRoot, view.number, view.headRefName);
  if (!worktreePath) {
    console.log("(worktree materialization unavailable — this verdict will post keyword-only)");
  }

  // W1-T185 (Gap 2, criterion 6): withMaterializedWorktree guarantees teardown
  // on EVERY exit path, including a throw from runReview itself — never just
  // the success path, which would reproduce the W1-T175 leak class.
  const verdict = await withMaterializedWorktree(worktreePath, repoRoot, () =>
    runReview({
      owner,
      repo,
      prUrl: view.url,
      task: { id: taskId ?? `PR-${view.number}`, acceptance: criteria },
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
      ledgerPath,
      runId,
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
      log("automerge.capped_override_granted", { by: overrideBy, reason: overrideReason, pr_url: view.url });
      console.log(`CAPPED override recorded — by ${overrideBy}: ${overrideReason} (task ${taskId})`);
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
async function depReviewCommand(prArg: string, rest: string[] = []): Promise<number> {
  const { owner, repo } = resolveReviewTarget(resolveOwnerRepo(), rest);
  const slug = `${owner}/${repo}`;
  const view = ghJson([
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
  const diff = execFileSync("gh", ["pr", "diff", view.url], { encoding: "utf8", maxBuffer: 1 << 26 });

  const config = loadConfig();
  const ledgerPath = join(config.root, "state", "ledger.ndjson");
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
    const posted = await postReviewStatusGuarded({
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
    armAutoMerge(view.url, taskId);
    log("automerge.armed", {});
    console.log(`remudero-review=success posted + auto-merge armed: ${view.url}`);
    return 0;
  }
  // escalate: post failure (NEVER auto-merge for a major) + open the MANUAL issue.
  const postedFailure = await postReviewStatusGuarded({
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
  const issueUrl = escalate(escalation, { issues: ghIssueGateway(owner, repo), ledgerPath, runId });
  log("dep-review.escalated", { issue_url: issueUrl });
  console.log(`remudero-review=failure posted (no auto-merge); escalated: ${issueUrl}`);
  return 1;
}

/**
 * `rmd lint-plan [--plan <path>] [--base <git-ref>]` — the CI half of §5C Layer A
 * (the pre-dispatch half lives in `runTask`, see `assertLintClean`).
 *
 * With `--base`, lints ONLY the task ids that are NEW or CHANGED relative to
 * that git ref (`changedTaskIds`, comparing `<ref>:plan/tasks.yaml` to the
 * working copy) — this is what makes the FAIL-CLOSED CI gate safe to turn on
 * immediately: it judges the PR's OWN edit, not the whole historical queue
 * (re-grading everything already open is the retro's separate, periodic
 * plan-health sweep, W1-T20d — not every PR's gate). Without `--base`, lints
 * the WHOLE plan (the mode a future retro sweep wants).
 *
 * Exits non-zero iff any IN-SCOPE task has a BLOCKING violation. Resolving
 * `--base` itself failing (bad ref, unreadable git history) is a LOUD
 * configuration error (exit 2), never a silent fall-back to full-plan or
 * no-op — the control surface never guesses on ambiguous input.
 */
async function lintPlanCommand(rest: string[]): Promise<number> {
  const badArg = unknownArgError("lint-plan", rest, ["--plan", "--base"], []);
  if (badArg) {
    console.error(badArg + "\n" + USAGE);
    return 2;
  }
  const planPath = flagValue(rest, "--plan") ?? join(repoRoot, "plan", "tasks.yaml");
  const baseRef = flagValue(rest, "--base");
  let plan: Plan;
  try {
    plan = loadPlan(planPath);
  } catch (e) {
    console.error(`### rmd lint-plan: ${(e as Error).message}`);
    return 2;
  }

  let scope: Set<string> | undefined;
  if (baseRef) {
    const relPath = relative(repoRoot, planPath);
    try {
      const oldRaw = execFileSync("git", ["show", `${baseRef}:${relPath}`], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      const oldPlan = loadPlanFromYaml(oldRaw, `${baseRef}:${relPath}`);
      scope = changedTaskIds(oldPlan.tasks, plan.tasks);
    } catch (e) {
      console.error(`### rmd lint-plan: cannot resolve --base ${baseRef}: ${(e as Error).message}`);
      return 2;
    }
  }

  let failing = 0;
  let warned = 0;
  let checked = 0;
  for (const task of plan.tasks) {
    if (scope && !scope.has(task.id)) continue;
    checked++;
    const { violations } = lintTask(task);
    const blocking = violations.filter((v) => v.severity === "block");
    const soft = violations.filter((v) => v.severity === "warn");
    if (blocking.length) {
      failing++;
      console.error(`✗ ${task.id}: ${blocking.length} violation(s)`);
      for (const v of blocking) console.error(`    [${v.check}] ${v.message}`);
    }
    for (const v of soft) {
      warned++;
      console.warn(`  ⚠ ${task.id}: [${v.check}] ${v.message}`);
    }
  }
  const scopeNote = scope ? ` (${scope.size} new/changed vs ${baseRef})` : "";
  console.log(`\nrmd lint-plan: ${checked} task(s) checked${scopeNote} — ${failing} failing, ${warned} warning(s)`);
  return failing > 0 ? 1 : 0;
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
async function retroCommand(rest: string[]): Promise<number> {
  const dryRun = rest.includes("--dry-run");
  const config = loadConfig();
  const ledgerPath = join(config.root, "state", "ledger.ndjson");
  const markerPath = join(config.root, "state", "last-retro.json");
  const learningsPath = join(repoRoot, "LEARNINGS.md");
  const ledgerNdjson = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : "";
  const learningsMd = existsSync(learningsPath) ? readFileSync(learningsPath, "utf8") : "";
  const marker = loadMarker(markerPath);
  // W1-T132: resolved EARLY (a pure git-config read, no spawn) so the SHIPPED
  // union (W1-T51's shippedSince) can be wired into the gather from the start —
  // omitting `github` here degrades `shipped` to the ledger-only list, which is
  // structurally EMPTY in the gate-side-merge era (every merge now lands via the
  // gate, never a ledger verdict=merged write).
  const { owner, repo } = resolveOwnerRepo();
  const baseGithub = ghGateway(owner, repo);
  // DEGRADE LOUDLY (design ii): `unavailable` is checked ONCE per gather via a
  // real `gh api rate_limit` probe — an exhausted quota or a `gh` CLI failure is
  // NAMED in the rendered report rather than silently read as "nothing shipped"
  // (every findMergedByTrailer/headRefName call would otherwise fail the same
  // way a genuine absence does). This exact object literal (not a spread) keeps
  // it structurally matched to ShippedGithub — no excess properties leaking in
  // from GitHub's wider surface (prByRef/prBody).
  const github: ShippedGithub = {
    findMergedByTrailer: (taskId) => baseGithub.findMergedByTrailer(taskId),
    headRefName: (prUrl) => baseGithub.headRefName(prUrl),
    unavailable: () => probeGithubThrottle(),
  };
  const gather = buildGather({
    ledgerNdjson,
    learningsMd,
    sinceTs: marker?.ts,
    learningsAtMarker: marker?.learnings_count,
    github,
  });
  // W1-T111 (P25 iv): the approve/reframe rate is telemetry, not decoration — the field's
  // failure mode is the rubber-stamp queue, so it rides EVERY retro (cumulative, all-time,
  // never scoped to `sinceTs` — a fatigue signal needs the whole history to be trustworthy).
  // lib/retro.ts itself stays untouched; this is a standalone section concatenated on.
  const report = [renderGather(gather), "", renderRatifyTelemetry(ratifyTelemetry(parseLedger(ledgerNdjson)))].join("\n");

  if (dryRun) {
    console.log(report);
    return 0;
  }

  // G-17 Tier Invariant: the retro Architect MUST outrank implement workers.
  const arch = architectModel(config);
  const wrk = workerModel(config);
  assertArchitectAboveWorker(arch, wrk); // throws (fail-closed) on violation

  // MOUNT-GOVERNED (§9, W1-T64 — sibling of W1-T63/P10): the retro/architect spawn's
  // turn budget comes from mounts.yaml's `architect` row (the flat-400 tripwire, #90),
  // NEVER a hardcoded literal. Before this, a hardcoded 40-turn cap — the SAME class of
  // cap that walled the reviewer (error_max_turns) — could wall the Architect mid-retro
  // BEFORE it staged/committed/pushed/opened the PR, leaving an empty branch that then
  // crashed `gh pr create --fill` (no diff to fill).
  const mountsTable = loadMounts(mountsPath(repoRoot));

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
    const proj = projectPlan(orientationPlan, { ledgerPath, github: ghGateway(owner, repo) }, statusPath);
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
    const worker = await spawnWorker({
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
      execFileSync("git", ["-C", worktreePath, "push", "origin", "HEAD"], { stdio: "inherit" });
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
      const out = execFileSync(
        "gh",
        ["pr", "create", "--repo", `${owner}/${repo}`, "--base", "main", "--head", branch, "--fill"],
        { encoding: "utf8" },
      );
      prUrl = out.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/)?.[0];
    }
    if (!prUrl) {
      log("retro.error", { error: "no PR opened" });
      worktreeRemove(repoDir, worktreePath);
      return 1;
    }
    // RUN-OWNERSHIP GUARD (W1-T62) — same backstop as runTaskBody: before any side
    // effect touches this PR, assert it is actually this retro's own PR.
    const ownership = checkPrOwnership(prUrl, branch, ghPrHeadGateway(), worker.costUsd);
    if (ownership) {
      log("verdict", ownership.ledger);
      say(
        `verdict: pr_attribution_failed — claimed PR ${prUrl} (branch ${ownership.ledger.claimed_branch ?? "unresolved"}) ` +
          `is not this retro's own branch (${branch}) — PR left UNTOUCHED`,
      );
      worktreeRemove(repoDir, worktreePath);
      return 1;
    }
    ensureTaskTrailer(prUrl, "RETRO");

    // W1-T136 (#394 class): verify-and-repair the PR body's Acceptance block BEFORE the
    // gate runs. retroPrompt instructs the Architect worker to write one, but that's
    // advisory (an LLM can get the shape wrong, e.g. #394's non-bare header, which
    // parseAcceptanceBlock never recognizes) — this harness-side pass is the
    // deterministic backstop so a worker's shape mistake doesn't fail the whole retro
    // CLOSED at remudero-review. Best-effort: never lets this crash an otherwise-fine retro.
    try {
      const view = ghJson(["pr", "view", prUrl, "--json", "body"]) as { body?: string };
      const body = view.body ?? "";
      if (parseAcceptanceBlock(body).length === 0) {
        const repaired = ensureJudgeableBody(body, [
          {
            claim: "the retro's plan-only sync PR is gate-compliant",
            proof:
              "SHIPPED-log/NET-STATE/calibration-table updates and the COMPRESSION deletion are in this diff; " +
              "docs/ORIENTATION.md and plan/plan-index.json are harness-regenerated separately in this same PR",
          },
        ]);
        execFileSync("gh", ["pr", "edit", prUrl, "--body", repaired], { stdio: "pipe" });
        log("acceptance.repaired", { pr_url: prUrl });
      }
    } catch (e) {
      log("acceptance.repair.error", { error: String((e as Error)?.message ?? e) });
    }

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
    const nextMarker = { ts: new Date().toISOString(), learnings_count: gather.learningsNow, runs_seen: gather.totalRuns };
    writeFileSync(markerPath, JSON.stringify(nextMarker, null, 2) + "\n");
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
    // W1-T230: reviewCommand resolved this PR's task id off its own
    // `Remudero-Task: RETRO` trailer (ensureTaskTrailer above), so its
    // review.posted ledger line is keyed "RETRO" too — the SAME literal
    // armAutoMerge must pass to find it.
    armAutoMerge(prUrl, "RETRO");
    log("automerge.armed", {});
    worktreeRemove(repoDir, worktreePath);
    say(`retro PR gated + armed (review ${reviewCode === 0 ? "success" : "failure"}): ${prUrl}`);
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

/** Read current `/usage` headless and parse it; `undefined` on any failure (best-effort). */
function readUsageSnapshot(config: Config): UsageSnapshot | undefined {
  try {
    const env = buildWorkerEnv({}, process.env, {
      zdotdir: workerZdotdir(config),
      shell: workerShell(config),
    });
    const out = execFileSync(config.claudeBin, ["-p", "/usage"], {
      encoding: "utf8",
      env,
      maxBuffer: 1 << 24,
    });
    return parseUsage(out);
  } catch {
    return undefined; // unreadable ⇒ the drain continues (max + budget still bound it)
  }
}

/**
 * P29(ii)'s escalation side — called once `nextRunnable`'s `isCircuitTripped`
 * (status.ts's `isDispatchBreakerTripped`) reports a task has been dispatched
 * the policy-capped number of times with no new owned PR since. DEDUPED: a
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
 * `rmd drain [--until <id>] [--max <n>] [--dry-run]` — drain the DAG through the
 * EXISTING run-task path. Thin + deterministic: next-runnable is the plan.ts DAG
 * logic over GitHub-derived status; it STOPS ON ANY BLOCK (v1); it is headroom-aware
 * and bounded. See lib/drain.ts for the loop; this only wires the real defaults.
 */
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

  const baseOpts: DrainOpts = {
    until: untilIdx >= 0 ? rest[untilIdx + 1] : undefined,
    max: maxIdx >= 0 ? Number(rest[maxIdx + 1]) : DRAIN_DEFAULT_MAX,
  };
  const opts: DrainOpts = curatedSelection ? applyCuratedSelection(baseOpts, curatedSelection) : baseOpts;
  const config = deps.config ?? loadConfig();
  const planPath = deps.planPath ?? join(repoRoot, "plan", "tasks.yaml");
  const ledgerPath = join(config.root, "state", "ledger.ndjson");
  const statusPath = join(config.root, "state", "status.json");
  const self = resolveOwnerRepo();
  const { owner } = self;
  // Gateway repo, parameterized like the daemon path (fix/daemon-repo-targeting): defaults to
  // THIS checkout's own repo rather than a hardcoded literal, so a checkout whose origin isn't
  // `remudero` (e.g. a sandbox) doesn't silently project merged-status against the wrong repo.
  // --repo overrides it explicitly. The plan itself is unaffected — drain always dispatches
  // from THIS checkout's origin/main (git self-sync below); only the status gateway moves.
  const repo = flagValue(rest, "--repo") ?? self.repo;
  const githubFactory = deps.githubFactory ?? ghGateway;

  const runId = `DRAIN-${Date.now()}`;
  const log = (step: string, extra: Record<string, unknown> = {}) =>
    appendLedger(ledgerPath, { run_id: runId, task_id: "DRAIN", step, ...extra });

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
  // W1-T119: same freshness contract as `isOpenPr` — the SAME projection
  // `refreshMerged` just derived, never a second GitHub read path.
  const isIndeterminate = (id: string) => lastProj?.get(id)?.indeterminate === true;

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

  try {
    const summary = await runDrain(
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
        // unlike the daemon's in-memory per-tick block flag.
        isCircuitTripped: (taskId) => isDispatchBreakerTripped(readLedgerLines(ledgerPath), taskId),
        onCircuitBreak: (t) => escalateCircuitBreak(t, { owner, repo, ledgerPath, runId }),
        runOne: (taskId) => runTask(taskId, { planPath, config, allowStale }),
        readUsage: () => readUsageSnapshot(config),
        checkStop: () => stopDetail(config.root),
        checkPause: () => pauseDetail(config.root),
        log,
      },
      opts,
    );
    console.log("\n" + renderSummary(summary));
    // POST-DRAIN RUNDOWN (W1-T141): one classified merged/blocked/escalated line per attempted
    // task — "what happened" at task grain, not just the aggregate summary above. Re-reads the
    // ledger fresh so a same-run escalation (BLOCKED class, two-strikes-exhausted) is visible to
    // the classifier — the SAME ledger file `log` above just finished writing into.
    console.log("\n" + renderRundown(buildRundown(summary, readLedgerLines(ledgerPath))));
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
async function daemonCommand(rest: string[]): Promise<number> {
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
    console.error(badArg + "\n" + USAGE);
    return 2;
  }
  const allowStale = rest.includes("--allow-stale");
  const maxIdx = rest.indexOf("--max");
  const pollIdx = rest.indexOf("--poll-ms");
  const opts: DaemonOpts = {
    max: maxIdx >= 0 ? Number(rest[maxIdx + 1]) : undefined,
    pollIntervalMs: pollIdx >= 0 ? Number(rest[pollIdx + 1]) : DEFAULT_POLL_INTERVAL_MS,
  };
  const config = loadConfig();
  const ledgerPath = join(config.root, "state", "ledger.ndjson");
  const statusPath = join(config.root, "state", "status.json");
  const self = resolveOwnerRepo();
  const reposDir = join(config.root, "repos");

  // ── REPO TARGETING + self-target GUARD (fix/daemon-repo-targeting). The daemon must know
  // WHICH repo to drain, EXPLICITLY — the old code read the plan from its own checkout and
  // hardcoded the "remudero" gateway, so an unattended run silently drained its own source.
  // --repo/--plan choose the gateway + plan source; W1-T12d targets the sandbox explicitly.
  const resolved = resolveDaemonTarget(
    { selfOwner: self.owner, selfRepo: self.repo, repoRoot, reposDir },
    rest,
  );
  if ("error" in resolved) {
    console.error(resolved.error + "\n" + USAGE);
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
      say: (msg) => console.error(`### rmd daemon — ${msg}`),
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
  const refreshMerged: () => MergedSet = () => {
    const proj = projectPlan(
      plan,
      { ledgerPath, github: ghGateway(target.owner, target.repo) },
      statusPath,
    );
    lastProj = proj;
    return (id: string) => proj.get(id)?.merged ?? false;
  };
  const isOpenPr: OpenPrCheck = (id) => {
    const p = lastProj?.get(id);
    return p?.prState === "OPEN" ? p.prNumber : undefined;
  };
  // W1-T119: same freshness contract as `isOpenPr` — the SAME projection
  // `refreshMerged` just derived, never a second GitHub read path.
  const isIndeterminate = (id: string) => lastProj?.get(id)?.indeterminate === true;

  // DRY-RUN: preview the resolved target + planned sequence, spawn NOTHING, take NO lock.
  if (target.dryRun) {
    const seq = plannedSequence(plan, refreshMerged(), { max: opts.max ?? DRAIN_DEFAULT_MAX });
    console.log(`### rmd daemon --dry-run — target ${target.owner}/${target.repo} · plan ${target.planPath}`);
    console.log(seq.length ? seq.map((id, i) => `  ${i + 1}. ${id}`).join("\n") : "  (nothing runnable now)");
    if (target.isSelf) console.warn("  ⚠️ SELF-HOSTING target — the daemon's own source repo.");
    return 0;
  }

  if (target.isSelf) {
    console.warn(
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
      console.error(
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
  });
  // ANTHROPIC-clean-env boot assertion (W1-T12b): checked once, before the loop
  // starts, over the daemon process's OWN live env — belt-and-suspenders atop
  // the launchd unit's own closed EnvironmentVariables allowlist (lib/launchd.ts).
  // Also runs the W1-T115 boot sweep of stale rmd-owned temp dirs (the
  // 26,711-dir ENOSPC incident's backstop) and logs the count via daemon.tmp_sweep.
  daemonBoot(
    log,
    process.env,
    () => sweepStaleTempDirs(),
    () => sweepStaleInflightLocks(join(config.root, "state", "inflight")),
  );

  try {
    const summary = await runDaemon(
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
        // loop's own in-memory per-tick block-reasoning flag.
        isCircuitTripped: (taskId) => isDispatchBreakerTripped(readLedgerLines(ledgerPath), taskId),
        onCircuitBreak: (t) => escalateCircuitBreak(t, { owner: target.owner, repo: target.repo, ledgerPath, runId }),
        runOne: (taskId) =>
          runTask(taskId, {
            planPath: target.planPath,
            config,
            allowStale,
            skipGitSync: !!flagValue(rest, "--plan"),
          }),
        readUsage: () => readUsageSnapshot(config),
        checkStop: () => stopDetail(config.root),
        checkPause: () => pauseDetail(config.root),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        // The real wall clock backing the TIME-AWARE headroom ceiling (see
        // lib/daemon.ts's HeadroomPolicy) — resolves each window's own
        // hours-to-reset. Explicit here (though `runDaemon` defaults the same
        // way when omitted) so the real wiring is as self-documenting as `sleep`.
        now: () => new Date(),
        // LEVEL-TRIGGERED PR-PIPELINE RECONCILER (W1-T77): the SAME runSweep the
        // `rmd sweep` CLI invokes, run once per poll iteration so no open PR
        // strands open-and-orphaned (#111/#113/#123). Best-effort by contract.
        sweep: buildSweepHook(target.owner, target.repo, config, ledgerPath, runId, plan, log),
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
    console.log("\n" + renderDaemonSummary(summary));
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
 * `rmd daemon-plist [--poll-ms <n>] [--write]` — GENERATE the launchd unit for
 * `rmd daemon` (W1-T12b; lib/launchd.ts owns the generation, this only wires
 * the real absolute paths). Default: print the .plist to stdout, plus the
 * `launchctl load` invocation the operator would run, and do nothing else.
 * `--write` additionally writes it to `~/Library/LaunchAgents/<label>.plist` —
 * still just a file write, never a `launchctl` call. Actually LOADING it on a
 * real user session is W1-T12d (verify:human) — this command only gets the
 * operator to the point of running `launchctl load` themselves.
 */
async function daemonPlistCommand(rest: string[]): Promise<number> {
  const badArg = unknownArgError("daemon-plist", rest, ["--poll-ms", "--repo"], ["--write"]);
  if (badArg) {
    console.error(badArg + "\n" + USAGE);
    return 2;
  }
  const config = loadConfig();
  const pollIdx = rest.indexOf("--poll-ms");
  const pollIntervalMs = pollIdx >= 0 ? Number(rest[pollIdx + 1]) : undefined;
  const repo = flagValue(rest, "--repo"); // baked into the unit so it drains the intended repo
  const rmdBin = join(repoRoot, "bin", "rmd");
  const plist = generateLaunchdPlist({ rmdBin, root: config.root, pollIntervalMs, repo });
  const plistPath = launchdPlistPath();
  if (!repo) {
    console.warn(
      `### rmd daemon-plist — WARNING: no --repo given, so the unit runs \`rmd daemon\` with no ` +
        `target. The daemon's self-target guard will REFUSE to start it (no silent self-drain). ` +
        `For commissioning: \`rmd daemon-plist --repo remudero-sandbox --write\`.`,
    );
  }

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

// ── rmd serve — the operator console FRONT DOOR (W1-T139, MASTER-PLAN §7/§7B) ──
//
// Real business logic lives entirely in the four already-proven modules lib/serve.ts
// assembles (service.ts, board.ts, panel-actions.ts, panel-graph.ts); this command is CLI
// glue only — resolve the port, load/generate the bearer tokens, build the real deps (the
// real ghGateway/ghTraceGateway/ghIssueCloser, the real plan, the real ledger path), bind,
// print the console URL, and block until SIGINT/SIGTERM.
async function serveCommand(rest: string[]): Promise<number> {
  const badArg = unknownArgError("serve", rest, ["--port"], []);
  if (badArg) {
    console.error(badArg + "\n" + USAGE);
    return 2;
  }
  let port: number;
  let hosts: string[];
  try {
    port = resolveServePort(rest);
    hosts = resolveServeHosts(rest);
  } catch (e) {
    console.error(`### rmd serve — ${(e as Error).message}\n${USAGE}`);
    return 2;
  }

  const config = loadConfig();
  const self = resolveOwnerRepo();
  const planPath = join(repoRoot, "plan", "tasks.yaml");
  const ledgerPath = join(config.root, "state", "ledger.ndjson");
  const plan = loadPlan(planPath);
  const tokens = resolveServiceTokens(config.root);

  const runId = `SERVE-${Date.now()}`;
  const log = (step: string, extra: Record<string, unknown> = {}) =>
    appendLedger(ledgerPath, { run_id: runId, task_id: "SERVE", step, ...extra });

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
    board: { plan, ledgerPath, github: boardGithub },
    // panel-graph.ts reloads plan/tasks.yaml fresh on every GET /v1/trace (its own header) --
    // planPath alone is enough, no snapshot needed here the way board.ts's does.
    // `statusGithub` backs GET /v1/drain/preview's (W1-T140) merged-set derivation --
    // the SAME batched gateway the board route above uses, never a second gateway type.
    panelGraph: {
      root: repoRoot,
      planPath,
      ledgerPath,
      github: ghTraceGateway(self.owner, self.repo),
      statusGithub: boardGithub,
    },
    ledgerPath,
    issues: ghIssueCloser(),
    // See lib/serve.ts's module header ("TWO ROOTS, ONE PanelActionDeps SHAPE") for why these
    // differ: fleet-control flag files must match what `rmd daemon`/`rmd drain` check
    // (config.root); plan/questions.ndjson must match where `appendQuestion` writes (repoRoot).
    fleetControlRoot: config.root,
    questionsRoot: repoRoot,
    tokens,
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
      await new Promise<void>((resolve, reject) => {
        target.once("error", reject);
        target.listen(port, h, resolve);
      });
    }
  } catch (e) {
    console.error(`### rmd serve — failed to listen on ${hosts.join(", ")}:${port}: ${(e as Error).message}`);
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
 * Build the observed open-PR state the sweep reconciles — the real gateway
 * (`gh pr list --state open`), cross-referenced with the ledger. No `gh`/network
 * lives in lib/sweep.ts; this is the injected edge.
 */
function buildOpenPrViews(owner: string, repo: string, ledgerPath: string): OpenPrView[] {
  const raw = ghJson([
    "pr", "list", "--repo", `${owner}/${repo}`, "--state", "open", "--limit", "100",
    "--json", "number,url,headRefName,headRefOid,updatedAt,body,autoMergeRequest,statusCheckRollup",
  ]) as RawOpenPr[];
  const ledger = readLedgerLines(ledgerPath);
  // W1-T103: branch protection's OWN required-contexts list, read ONCE per
  // repo for this whole sweep pass (never per-PR, never hardcoded) — see
  // checksStateFromRollup's doc for why this must gate checksState instead of
  // every reported check.
  const requiredContexts = ghRequiredStatusCheckContexts(owner, repo);

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
      reviewSummary: undefined,
      // W1-T100: the ci-log fix mode's input — only worth fetching when checks
      // are actually red (a PR gate that already needs blocked_ci's rung).
      ciFailures: checksState === "red" ? fetchCiFailures(owner, repo, pr.statusCheckRollup) : undefined,
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
 * Wire the four gated effects to their real implementations. dispatchFix
 * reconstructs a W1-T76 `runFixRung` invocation for a PR discovered COLD (no live
 * run/session): it checks the PR head branch out into a scratch worktree, seeds a
 * failing verdict from the ledger's unmet criteria, and degrades strike 1 to a
 * FRESH spawn (a spawn adapter drops an empty resumeSessionId). All effects are
 * fail-soft — a reconstruction hiccup escalates rather than crashing the sweep,
 * so one bad PR never strands the reconciler over the rest.
 */
function buildSweepEffects(
  owner: string,
  repo: string,
  config: Config,
  ledgerPath: string,
  runId: string,
  plan: Plan,
  log: (step: string, extra?: Record<string, unknown>) => void,
  policy: SweepPolicy = DEFAULT_SWEEP_POLICY,
): Pick<SweepDeps, "arm" | "close" | "dispatchFix" | "escalate" | "readLiveState"> {
  const repoDir = repo === resolveOwnerRepo().repo ? repoRoot : join(config.root, "repos", repo);
  const issues = ghIssueGateway(owner, repo);
  const say = (msg: string) => console.error(`### rmd sweep — ${msg}`);

  return {
    arm: (pr) => armAutoMerge(pr.prUrl, pr.taskId),

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
          taskId: pr.taskId ?? "UNKNOWN",
          runId,
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
      // W1-T100: `evidence.ciFailures` is defined ONLY for a blocked_ci
      // dispatch (runSweep/routeFix set it, undefined otherwise) — the SAME
      // discriminator both callers use to pick this evidence shape.
      const isCiLog = evidence.ciFailures !== undefined;
      const unmet = evidence.unmetCriteria;
      const task = plan.tasks.find((t) => t.id === pr.taskId);
      if (!task) {
        log("sweep.fix.no_task", { pr_number: pr.prNumber, task_id: pr.taskId });
        return;
      }
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
        const headRef = ghJson(["pr", "view", pr.prUrl, "--json", "headRefName"]) as {
          headRefName?: string;
        };
        const realBranch = headRef.headRefName;
        if (!realBranch || !new RegExp(`^run-${task.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d+$`).test(realBranch)) {
          log("sweep.fix.uncreditable_head", { pr_number: pr.prNumber, head: realBranch });
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

        // A failing verdict seeded from the ledger's unmet criteria (review mode)
        // — OR, for a blocked_ci dispatch (W1-T100, broadened by W1-T138 to fire
        // regardless of the review verdict beside it), a placeholder verdict:
        // `criteria: []` so the rung never re-litigates a review verdict that may
        // be stale or simply irrelevant until the red check goes green (a FRESH
        // review only ever runs once CI is green). Either way, the fix rung
        // re-derives the AUTHORITATIVE verdict via runReview after each strike.
        const initialReview: ReviewVerdict & { headSha: string; reviewerOutcome: string } = isCiLog
          ? {
              state: "failure",
              criteria: [],
              testTheater: false,
              summary: `sweep-reconstructed: required checks red (${(evidence.ciFailures ?? []).length} failing check(s)) — ci-log dispatch, any review verdict on this head is disregarded until checks are green`,
              floorDegraded: false,
              capped: false,
              keywordOnly: false,
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
              headSha: pr.headSha,
              reviewerOutcome: "sweep-reconstructed",
            };

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
          taskId: task.id,
          runId,
          task,
          prUrl: pr.prUrl,
          branch: realBranch,
          worktreePath,
          initialSessionId: "", // cold PR: no session — strike 1 degrades to fresh (adapter below)
          mount: fixMount,
          settingsFile,
          config,
          budgetUsd,
          strikeCap,
          initialReview,
          constraint: pr.pendingAnswer?.constraint,
          ciFailures: evidence.ciFailures,
          reviewBase: { owner, repo, headCheckoutDir: worktreePath, reviewerMount },
          deps: {
            // Fresh-spawn adapter: an empty resumeSessionId (cold PR) becomes a
            // fresh spawn rather than an attempt to resume a session that doesn't exist.
            spawn: (args) => spawnWorker({ ...args, resumeSessionId: args.resumeSessionId || undefined }),
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
                execFileSync("git", ["-C", wt, "push", "origin", "HEAD"], { stdio: "ignore" });
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
async function sweepCommand(rest: string[]): Promise<number> {
  const badArg = unknownArgError("sweep", rest, ["--repo"], ["--dry-run"]);
  if (badArg) {
    console.error(badArg + "\n" + USAGE);
    return 2;
  }
  const dryRun = rest.includes("--dry-run");
  const config = loadConfig();
  const ledgerPath = join(config.root, "state", "ledger.ndjson");
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

  console.log(
    `### rmd sweep${dryRun ? " --dry-run" : ""} — ${owner}/${repo}\n` +
      renderSweepSummary(summary) +
      `\ncredit backfill: ${creditSummary.total} candidate(s) reconciled · ${creditSummary.corrected} corrected`,
  );
  return 0;
}

/**
 * The daemon's per-iteration sweep hook (acceptance 4: the SAME runSweep the CLI
 * uses). Best-effort by the DaemonDeps.sweep contract — swallows its own errors so
 * a sweep hiccup never halts the scheduler loop.
 */
function buildSweepHook(
  owner: string,
  repo: string,
  config: Config,
  ledgerPath: string,
  runId: string,
  plan: Plan,
  log: (step: string, extra?: Record<string, unknown>) => void,
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
      // W1-T150: the SAME credit-backfill rung `rmd sweep` runs, on the
      // daemon's own poll cadence — never a second, separately-scheduled loop.
      const creditCandidates = buildCreditCandidates(owner, repo, plan, ledgerPath, log);
      await runCreditBackfill(creditCandidates, { ledgerPath, runId, log });
    } catch (e) {
      log("sweep.error", { error: String((e as Error)?.message ?? e) });
    }
    // W1-T192: the draft rung (fail-soft internally, its own try/catch) — a fired trigger
    // or an invalidated draft gets redrafted here, on the daemon's cadence, with no CLI
    // invocation required.
    await draftHook();
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
async function fixCommand(rest: string[]): Promise<number> {
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

  const config = loadConfig();
  const ledgerPath = join(config.root, "state", "ledger.ndjson");
  const self = resolveOwnerRepo();
  const repo = flagValue(rest, "--repo") ?? self.repo;
  const owner = self.owner;
  const runId = `FIX-${Date.now()}`;
  const log = (step: string, extra: Record<string, unknown> = {}) =>
    appendLedger(ledgerPath, { run_id: runId, task_id: "FIX", step, ...extra });

  let raw: RawOpenPr & { state?: string };
  try {
    raw = ghJson([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      `${owner}/${repo}`,
      "--json",
      "number,url,headRefName,headRefOid,updatedAt,body,autoMergeRequest,statusCheckRollup,state",
    ]) as RawOpenPr & { state?: string };
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
 * `rmd stop [--reason <text>]` — the fleet control set (W1-T11, MASTER-PLAN §4A/§4B).
 * Writes the STOP flag file. A `rmd drain` already running halts within one tick
 * (checked FIRST, every iteration, ahead of PAUSE); a NEW `rmd drain` refuses to
 * spawn anything until `rmd resume` clears it — same check, same code path.
 */
async function stopCommand(rest: string[]): Promise<number> {
  const config = loadConfig();
  const reason = flagValue(rest, "--reason");
  const ledgerPath = join(config.root, "state", "ledger.ndjson");

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
  const ledgerPath = join(config.root, "state", "ledger.ndjson");
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
  const ledgerPath = join(config.root, "state", "ledger.ndjson");
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
 * Opens the `needs-human` labeled issue (escalate.ts) and, for MANUAL/HARD_STOP
 * ONLY, also fires a real-time iMessage ping (§4: BLOCKED collapses to the digest).
 */
async function escalateCommand(rest: string[]): Promise<number> {
  const cls = flagValue(rest, "--class");
  const taskId = flagValue(rest, "--task");
  const summary = flagValue(rest, "--summary");
  if (!cls || !ESCALATION_CLASSES.includes(cls as EscalationClass) || !taskId || !summary) {
    console.error(`usage: ${commandSyntax("escalate")}`);
    return 2;
  }
  const config = loadConfig();
  const { owner, repo } = resolveOwnerRepo();
  const ledgerPath = join(config.root, "state", "ledger.ndjson");
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
    { issues: ghIssueGateway(owner, repo), ledgerPath, runId },
  );
  console.log(url);
  if (cls === "MANUAL" || cls === "HARD_STOP") {
    notify(`[${cls}] ${taskId}: ${summary}\n${url}`, {
      channel: imessageChannel(notifyRecipient(config)),
      ledgerPath,
      runId,
      taskId,
    });
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
  const ledgerPath = join(config.root, "state", "ledger.ndjson");
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
const TRIAGE_WORKER_TOOLS = ["Read", "Write", "Grep", "Glob", "WebSearch"];

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
async function triageCommand(rest: string[]): Promise<number> {
  const parsed = parseTriageArgs(rest);
  if ("error" in parsed) {
    console.error(parsed.error + "\n" + USAGE);
    return 2;
  }
  const { feedbackId } = parsed;

  const config = loadConfig();
  const { owner, repo } = resolveOwnerRepo();

  // G-17 Tier Invariant: the triage Architect MUST outrank implement workers.
  const arch = architectModel(config);
  const wrk = workerModel(config);
  assertArchitectAboveWorker(arch, wrk); // throws (fail-closed) on violation
  const mountsTable = loadMounts(mountsPath(repoRoot));

  const ledgerPath = join(config.root, "state", "ledger.ndjson");
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

  try {
    // Read the entry from the FRESH worktree (origin/main snapshot), not repoRoot, which may be
    // a stale checkout — same discipline retro's next-task read follows.
    let entry;
    try {
      entry = readFeedbackEntry(worktreePath, feedbackId);
    } catch (e) {
      log("triage.error", { error: String((e as Error)?.message ?? e) });
      say(`no such feedback entry: ${feedbackId}`);
      worktreeRemove(repoDir, worktreePath);
      return 2;
    }
    if (entry.status !== "new") {
      log("triage.error", { error: `feedback#${feedbackId} is not status:new (already ${entry.status})` });
      say(`feedback#${feedbackId} is already ${entry.status} — refusing to re-triage; nothing to do`);
      worktreeRemove(repoDir, worktreePath);
      return 1;
    }

    const worker = await spawnWorker({
      cwd: worktreePath,
      permissionMode: "bypassPermissions",
      settingsFile,
      model: arch, // the Architect tier
      maxTurns: mountsTable.architect.maxTurns, // MOUNT-GOVERNED (§9) — never a hardcoded literal.
      maxBudgetUsd: DEFAULT_BUDGET_USD,
      config,
      prompt: triagePrompt(entry, runId),
      tools: TRIAGE_WORKER_TOOLS,
    });
    log("triage.synthesized", {
      session_id: worker.sessionId,
      cost_usd: worker.costUsd,
      subtype: worker.subtype,
      ...workerLedgerFields(worker),
    });

    // Ground truth: what did the worker ACTUALLY touch (before the harness's own status write)?
    const changedFiles = execFileSync("git", ["-C", worktreePath, "diff", "--name-only", "origin/main"], {
      encoding: "utf8",
    })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const verdict = parseTriageVerdict([worker.text, worker.blocks.join("\n")].join("\n"));
    const decision = decideTriage({ verdict, changedFiles });

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
      grillIssueUrl = escalate(buildGrillEscalation({ entry, decision, taskId, runId }), {
        issues: ghIssueGateway(owner, repo),
        ledgerPath,
        runId,
      });
      log("triage.grill_opened", { issue_url: grillIssueUrl, options: decision.options.length, recommendation: decision.recommendation });
      say(`grill opened (needs-human, ${decision.options.length} options + a recommendation): ${grillIssueUrl}`);
    }

    // Harness-owned deterministic status write (never LLM-authored) — folded into the SAME diff
    // the worker produced, mirroring regenerateOrientation's post-worker deterministic commit.
    setFeedbackStatus(worktreePath, feedbackId, decision.status);
    execFileSync("git", ["-C", worktreePath, "add", "-A", "--", "plan/"], { stdio: "inherit" });
    const commitMessage = triageCommitMessage({ decision, feedbackId, taskId, grillIssueUrl });
    execFileSync("git", ["-C", worktreePath, "commit", "-m", commitMessage], { stdio: "inherit" });
    execFileSync("git", ["-C", worktreePath, "push", "origin", "HEAD"], { stdio: "inherit" });

    const out = execFileSync(
      "gh",
      ["pr", "create", "--repo", `${owner}/${repo}`, "--base", "main", "--head", branch, "--fill"],
      { encoding: "utf8" },
    );
    const prUrl = out.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/)?.[0];
    if (!prUrl) {
      log("triage.error", { error: "no PR opened" });
      worktreeRemove(repoDir, worktreePath);
      return 1;
    }

    // RUN-OWNERSHIP GUARD (W1-T62 precedent) — before any side effect touches this PR, assert it
    // is actually this triage run's own PR.
    const ownership = checkPrOwnership(prUrl, branch, ghPrHeadGateway(), worker.costUsd);
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
      setFeedbackStatus(worktreePath, feedbackId, "proposed", { proposalPr: prUrl });
      execFileSync("git", ["-C", worktreePath, "add", "-A", "--", "plan/feedback/"], { stdio: "inherit" });
      execFileSync(
        "git",
        ["-C", worktreePath, "commit", "-m", `chore(triage): record proposal_pr for feedback#${feedbackId}`],
        { stdio: "inherit" },
      );
      execFileSync("git", ["-C", worktreePath, "push", "origin", "HEAD"], { stdio: "inherit" });
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
    armAutoMerge(prUrl, taskId);
    log("automerge.armed", {});
    worktreeRemove(repoDir, worktreePath);
    say(`triage PR gated + armed (review ${reviewCode === 0 ? "success" : "failure"}): ${prUrl}`);
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
async function planCommand(rest: string[]): Promise<number> {
  const parsed = parsePlanArgs(rest);
  if ("error" in parsed) {
    console.error(parsed.error + "\n" + USAGE);
    return 2;
  }
  const { mode, brief } = parsed;

  const config = loadConfig();
  const { owner, repo } = resolveOwnerRepo();

  // G-17 Tier Invariant: the plan Architect MUST outrank implement workers.
  const arch = architectModel(config);
  const wrk = workerModel(config);
  assertArchitectAboveWorker(arch, wrk); // throws (fail-closed) on violation
  const mountsTable = loadMounts(mountsPath(repoRoot));

  const ledgerPath = join(config.root, "state", "ledger.ndjson");
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

  try {
    const worker = await spawnWorker({
      cwd: worktreePath,
      permissionMode: "bypassPermissions",
      settingsFile,
      model: arch, // the Architect tier
      maxTurns: mountsTable.architect.maxTurns, // MOUNT-GOVERNED (§9) — never a hardcoded literal.
      maxBudgetUsd: DEFAULT_BUDGET_USD,
      config,
      prompt: planArchitectPrompt(mode, brief, runId),
      tools: PLAN_WORKER_TOOLS,
    });
    log("plan.synthesized", {
      session_id: worker.sessionId,
      cost_usd: worker.costUsd,
      subtype: worker.subtype,
      ...workerLedgerFields(worker),
    });

    // Ground truth: what did the worker ACTUALLY touch?
    const changedFiles = execFileSync("git", ["-C", worktreePath, "diff", "--name-only", "origin/main"], {
      encoding: "utf8",
    })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const verdict = parsePlanVerdict([worker.text, worker.blocks.join("\n")].join("\n"));
    const decision = decidePlanArchitect({ verdict, changedFiles });

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
      log("plan.verdict", { action: "grill", detail: decision.detail });
      say(formatPlanVerdictLine(mode, decision));
      worktreeRemove(repoDir, worktreePath);
      return 0;
    }

    // propose
    log("plan.verdict", { action: "propose", detail: decision.detail, files: decision.files });
    say(formatPlanVerdictLine(mode, decision));
    const commitMessage = planCommitMessage({ decision, mode, brief, taskId });
    applyPlanProposalCommit(worktreePath, commitMessage);
    execFileSync("git", ["-C", worktreePath, "push", "origin", "HEAD"], { stdio: "inherit" });

    const out = execFileSync(
      "gh",
      ["pr", "create", "--repo", `${owner}/${repo}`, "--base", "main", "--head", branch, "--fill"],
      { encoding: "utf8" },
    );
    const prUrl = out.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/)?.[0];
    if (!prUrl) {
      log("plan.error", { error: "no PR opened" });
      worktreeRemove(repoDir, worktreePath);
      return 1;
    }

    // RUN-OWNERSHIP GUARD (W1-T62 precedent) — before any side effect touches this PR, assert it
    // is actually this plan run's own PR.
    const ownership = checkPrOwnership(prUrl, branch, ghPrHeadGateway(), worker.costUsd);
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
    armAutoMerge(prUrl, taskId);
    log("automerge.armed", {});
    worktreeRemove(repoDir, worktreePath);
    say(`plan PR gated + armed (review ${reviewCode === 0 ? "success" : "failure"}): ${prUrl}`);
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
  }
}

/** The bounded inbox-draft Architect worker's tool allowlist: Read/Grep/Glob ONLY — no
 *  Write/Edit/Bash. Drafting is TEXT the harness parses/caches state-side (never
 *  committed), so unlike `rmd triage`/`rmd plan` this worker never touches a file. */
const INBOX_DRAFT_WORKER_TOOLS = ["Read", "Grep", "Glob"];

/** Read a file's contents, or `undefined` if it doesn't exist — a single `readFileSync`
 *  guarded by `catch`, NOT a separate `existsSync` check-then-read (the latter is a
 *  TOCTOU race CodeQL flags: `js/file-system-race`, real here because `inboxCommand`
 *  later writes back to this same state path). */
function readFileIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (e: unknown) {
    if (e && typeof e === "object" && "code" in e && (e as { code: unknown }).code === "ENOENT") return undefined;
    throw e;
  }
}

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
async function draftProposalBatch(
  toDraft: Proposal[],
  config: Config,
  owner: string,
  repo: string,
  runId: string,
  log: (step: string, extra?: Record<string, unknown>) => void,
): Promise<DraftRungOutcome[]> {
  if (toDraft.length === 0) return [];

  const arch = architectModel(config);
  const wrk = workerModel(config);
  assertArchitectAboveWorker(arch, wrk); // throws (fail-closed) on violation
  const mountsTable = loadMounts(mountsPath(repoRoot));

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
function buildInboxDraftHook(
  owner: string,
  repo: string,
  config: Config,
  runId: string,
  log: (step: string, extra?: Record<string, unknown>) => void,
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

      const outcomes = await draftProposalBatch(due, config, owner, repo, runId, log);

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
      writeFileSync(draftsPath, JSON.stringify(nextDrafts, null, 2), "utf8");
      writeFileSync(attemptsPath, JSON.stringify(nextAttempts, null, 2), "utf8");
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
async function inboxCommand(rest: string[]): Promise<number> {
  const badArg = unknownArgError("inbox", rest, [], ["--dry-run"]);
  if (badArg) {
    console.error(badArg + "\n" + USAGE);
    return 2;
  }
  const dryRun = rest.includes("--dry-run");

  const config = loadConfig();
  const plan = loadPlan(join(repoRoot, "plan", "tasks.yaml"));
  const ledgerPath = join(config.root, "state", "ledger.ndjson");
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
  const { proposals: healedProposals, prunedIds } = pruneRatifiedProposals(proposals, classifications);
  if (prunedIds.length > 0) {
    writeFileSync(registryPath, JSON.stringify({ proposals: healedProposals }, null, 2), "utf8");
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
async function approveCommand(rest: string[]): Promise<number> {
  const proposalId = rest[0];
  const badArg = unknownArgError("approve", rest.slice(1), [], []);
  if (!proposalId || badArg) {
    console.error((badArg ?? `rmd approve: <P##> is required — usage: ${commandSyntax("approve")}`) + "\n" + USAGE);
    return 2;
  }

  const config = loadConfig();
  const plan = loadPlan(join(repoRoot, "plan", "tasks.yaml"));
  const ledgerPath = join(config.root, "state", "ledger.ndjson");
  const registryPath = join(config.root, "state", "inbox-proposals.json");
  const { owner, repo } = resolveOwnerRepo();

  const { proposal, proposals, classification } = loadProposalForRatify(proposalId, plan, ledgerPath, owner, repo, config);
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
  const gateway: RatifyGateway = {
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

      const tasksPath = join(worktreePath, "plan", "tasks.yaml");
      writeFileSync(tasksPath, applyFragmentToPlanYaml(readFileSync(tasksPath, "utf8"), payload.fragmentYaml), "utf8");
      const masterPlanPath = join(worktreePath, "MASTER-PLAN.md");
      writeFileSync(masterPlanPath, applyStampToMasterPlan(readFileSync(masterPlanPath, "utf8"), payload.proposalId, payload.stampLine), "utf8");

      // W1-T136 (#287 class): regenerate plan/plan-index.json to reflect the just-stamped
      // MASTER-PLAN.md BEFORE the single git-add below, which already sweeps up anything
      // under plan/ — no separate commit needed here, unlike retro's own commit.
      try {
        regeneratePlanIndexFile({ worktreePath });
      } catch (e) {
        log("plan_index.regen.error", { error: String((e as Error)?.message ?? e) });
      }

      // fragmentYaml is already a valid top-level sequence (schema v1 — see
      // applyFragmentToPlanYaml's doc comment), so a per-line regex over `- id: <id>` is
      // sufficient without a full YAML re-parse.
      filedTaskIds = [...payload.fragmentYaml.matchAll(/^- id:\s*(\S+)/gm)].map((m) => m[1]);

      execFileSync("git", ["-C", worktreePath, "add", "-A", "--", "plan/", "MASTER-PLAN.md"], { stdio: "inherit" });
      execFileSync("git", ["-C", worktreePath, "commit", "-m", approveCommitMessage(payload)], { stdio: "inherit" });
      execFileSync("git", ["-C", worktreePath, "push", "origin", "HEAD"], { stdio: "inherit" });
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

  const result = approveProposal(classification, gateway, { ledgerPath, runId });
  if (!result.ok) {
    console.error(`rmd approve: ${result.refusal}`);
    return 1;
  }

  // W1-T190: `ratify.approved` above just ledgered this proposal's ratification, but the
  // ledger and the registry are two different sources of truth — `rmd inbox`/the console's
  // `/v1/inbox` route (buildInboxRoute) classify strictly off state/inbox-proposals.json,
  // never the ledger, so leaving this entry in place kept recommending an already-ratified
  // proposal as READY indefinitely. Mirrors reframeCommand's registry write below (5646+ in
  // this file): this proposal is no longer ACTIVE (see the Proposal interface's doc comment
  // in lib/inbox.ts), so it is removed rather than rewritten in place.
  const nextProposals = proposals.filter((p) => p.id !== proposalId);
  writeFileSync(registryPath, JSON.stringify({ proposals: nextProposals }, null, 2), "utf8");

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
    armAutoMerge(result.prUrl, `PR-${prNum}`);
    log("automerge.armed", {});
    worktreeRemove(ownedRepoDir, ownedWorktreePath);
    console.log(`rmd approve: ${proposalId} gated + armed (review ${reviewCode === 0 ? "success" : "failure"}): ${result.prUrl}`);
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
 * `rmd reframe <P##> --feedback "<text>"` — the operator's OBJECTION path (MASTER-PLAN P25
 * iii, W1-T111): captures the feedback verbatim, ledgers `ratify.reframed`, and invalidates
 * the proposal's cached draft so the NEXT `rmd inbox` pass redrafts WITH the feedback in the
 * Architect prompt ({@link inboxDraftPrompt}). Valid for ANY proposal already in the
 * registry, whatever its current classification — reframe is feedback, never a
 * ratification, and opens no PR. State-side only (registry + draft cache + ledger); no
 * clone, no worktree, no `gh` call.
 */
async function reframeCommand(rest: string[]): Promise<number> {
  const proposalId = rest[0];
  const badArg = unknownArgError("reframe", rest.slice(1), ["--feedback"], []);
  if (!proposalId || badArg) {
    console.error((badArg ?? `rmd reframe: <P##> is required — usage: ${commandSyntax("reframe")}`) + "\n" + USAGE);
    return 2;
  }
  const feedback = flagValue(rest, "--feedback");
  if (!feedback) {
    console.error(`rmd reframe: --feedback "<text>" is required — usage: ${commandSyntax("reframe")}\n` + USAGE);
    return 2;
  }

  const config = loadConfig();
  const plan = loadPlan(join(repoRoot, "plan", "tasks.yaml"));
  const ledgerPath = join(config.root, "state", "ledger.ndjson");
  const { owner, repo } = resolveOwnerRepo();

  const registryPath = join(config.root, "state", "inbox-proposals.json");
  const { proposal, proposals, drafts, draftsPath } = loadProposalForRatify(proposalId, plan, ledgerPath, owner, repo, config);
  if (!proposal) {
    console.error(`rmd reframe: unknown proposal '${proposalId}' — not in the ACTIVE registry (${registryPath})`);
    return 2;
  }

  const runId = `REFRAME-${proposalId}-${Date.now()}`;
  const result = reframeProposal(proposal, feedback, drafts, { ledgerPath, runId });

  const nextProposals = proposals.map((p) => (p.id === proposalId ? result.proposal : p));
  writeFileSync(registryPath, JSON.stringify({ proposals: nextProposals }, null, 2), "utf8");
  writeFileSync(draftsPath, JSON.stringify(result.drafts, null, 2), "utf8");

  console.log(`rmd reframe: ${proposalId} — feedback ledgered, draft invalidated; the next \`rmd inbox\` pass will redraft with it.`);
  return 0;
}

/**
 * `rmd digest [--since <iso>] [--dry-run]` — roll up the ledger since `--since`
 * (default: 24h ago) into one message (digest.ts) and send it over iMessage;
 * `--dry-run` prints the text without sending.
 */
async function digestCommand(rest: string[]): Promise<number> {
  const since = flagValue(rest, "--since") ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const config = loadConfig();
  const ledgerPath = join(config.root, "state", "ledger.ndjson");
  if (rest.includes("--dry-run")) {
    console.log(buildDigest(ledgerPath, since));
    return 0;
  }
  const text = sendDigest(ledgerPath, since, {
    channel: imessageChannel(notifyRecipient(config)),
    ledgerPath,
    runId: `DIGEST-${Date.now()}`,
    taskId: "DIGEST",
  });
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
  const ledgerPath = join(config.root, "state", "ledger.ndjson");
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
  const ledgerPath = join(config.root, "state", "ledger.ndjson");
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
  const ledgerPath = join(config.root, "state", "ledger.ndjson");
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
  const ledgerPath = join(config.root, "state", "ledger.ndjson");
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
      "rmd run-task <task-id> [--allow-stale]   # dispatches from the origin/main plan blob (W1-T60), fetching first; --allow-stale proceeds on the last-fetched refs if the fetch fails instead of refusing",
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
      "rmd daemon-plist --repo <name> [--poll-ms <n>] [--write]   # generate the launchd unit for `rmd daemon`, baking in --repo so the unit drains the intended repo (commissioning is W1-T12d)",
  },
  {
    name: "serve",
    usage:
      "rmd serve [--port <n>] [--host <addr>]   # the operator console FRONT DOOR (W1-T139, MASTER-PLAN §7/§7B): one HTTP surface (service.ts) serving the live board (board.ts), fleet-control + question/manual-approve write actions (panel-actions.ts), the feedback inbox + plan→task→PR graph (panel-graph.ts), and a minimal HTML shell at GET /; bearer tokens are generated on first run and persisted 0600 under <config.root>/state/service-tokens.json, and rotate by stopping serve, deleting that file, and starting again; the startup banner prints the READ token only (a bookmark grants view, not control) and never the write token, because stdout is commonly redirected to a log; --port defaults to 4317 (matches apps/dashboard's own default); --host defaults to 127.0.0.1, also reads RMD_SERVE_HOST, accepts a COMMA-SEPARATED list so the console can be reachable locally AND from the phone (e.g. 127.0.0.1,<tailnet-ip>), and REFUSES wildcards like 0.0.0.0 anywhere in that list; blocks until SIGINT/SIGTERM",
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
      'rmd reframe <P##> --feedback "<text>"   # the feedback path (MASTER-PLAN P25(iii), W1-T111): ledgers ratify.reframed with the feedback verbatim, invalidates <P##>\'s cached draft, and appends to its reframe history so the NEXT `rmd inbox` draft-rung redrafts WITH the feedback in the Architect prompt; opens no PR, touches no git/gh — state-side only (registry + draft cache + ledger)',
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

// ── CLI entry (invoked by bin/rmd). Kept tiny; all logic is above/lib.
async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
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
  if (cmd === "run-task" && arg) {
    const badArg = unknownArgError("run-task", rest.slice(1), [], ["--allow-stale"]);
    if (badArg) {
      console.error(badArg + "\n" + USAGE);
      process.exit(2);
    }
    const result = await runTask(arg, { allowStale: rest.includes("--allow-stale") });
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
  if (cmd === "serve") {
    process.exit(await serveCommand(rest));
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
  if (cmd === "issues") {
    process.exit(await issuesCommand(rest));
  }
  if (cmd === "init") {
    process.exit(await initCommand(rest));
  }
  if (cmd === "project") {
    process.exit(await projectCommand(rest));
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
// Exported for a behavioral test of the retro no-op guard (W1-T64): commitsAhead is the predicate the
// retro/implement no-op path branches on (=== 0 ⇒ nothing to PR). Logic UNCHANGED — export only.
export { commitsAhead };
// Exported for W1-T47's help-registry test: COMMANDS is the ONE source of truth both USAGE
// (`rmd --help`) and commandHelp (`rmd <cmd> --help`) generate from — export only, logic unchanged.
// commandSyntax/commandSpec are the same lookup individual command handlers use for their
// inline usage hints (fix/escalate/notify/project/correct) — no hand-written duplicate text.
export { COMMANDS, USAGE, commandHelp, commandSpec, commandSyntax, type CommandSpec };
