import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  architectModel,
  configPath as instanceConfigPath,
  loadConfig,
  notifyRecipient,
  softBudgetThreshold,
  workerModel,
  workerShell,
  workerZdotdir,
  type Config,
} from "./lib/config.js";
import { buildWorkerEnv } from "./lib/env.js";
import { InitError, readClaudeJsonKeys, runInit } from "./lib/init.js";
import type { Tier, TierDetection } from "./lib/tier.js";
import {
  DEFAULT_MAX as DRAIN_DEFAULT_MAX,
  plannedSequence,
  renderSummary,
  resumeCommand,
  runDrain,
  type DrainOpts,
  type MergedSet,
} from "./lib/drain.js";
import { DEFAULT_POLL_INTERVAL_MS, daemonBoot, runDaemon, type DaemonOpts, type DaemonSummary } from "./lib/daemon.js";
import { generateLaunchdPlist, launchdPlistPath } from "./lib/launchd.js";
import { buildDigest, sendDigest } from "./lib/digest.js";
import { escalate, ghIssueGateway, type EscalationClass, type EscalationOption } from "./lib/escalate.js";
import { imessageChannel, notify } from "./lib/notify.js";
import { parseUsage, type UsageSnapshot } from "./lib/headroom.js";
import {
  assertArchitectAboveWorker,
  buildGather,
  calibrationTable,
  codeFilesInDiff,
  loadMarker,
  renderGather,
} from "./lib/retro.js";
import { appendLedger } from "./lib/ledger.js";
import {
  assertRunnable,
  loadPlan,
  selectTask,
  type AcceptanceCriterion,
  type Plan,
  type Task,
} from "./lib/plan.js";
import { loadMounts, mountsPath, resolveMount, type Mount } from "./lib/mounts.js";
import { ContainmentError, probeContainment } from "./lib/containment.js";
import {
  DEFAULT_KNOWLEDGE_BUDGET_CHARS,
  loadLearnings,
  renderLearningsContext,
  selectLearnings,
} from "./lib/learnings.js";
import { assertProvenance, citation } from "./lib/provenance.js";
import {
  REVIEW_CONTEXT,
  buildReviewPrompt,
  judgeReview,
  parseAcceptanceBlock,
  parseReviewerVerdicts,
  postReviewStatus,
  reviewerVerdictContract,
  type ReviewVerdict,
} from "./lib/review.js";
import { validateWorkerSettingsFile } from "./lib/settings.js";
import { ghGateway, projectPlan } from "./lib/status.js";
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
  workerLedgerFields,
  worktreeAdd,
  worktreeRemove,
  worktreesDir,
  writeRunLock,
  type WorkerResult,
} from "./lib/worker.js";
import { acquireDrainLock, defaultIsPidAlive, DrainLockError, readDrainLock } from "./lib/drain-lock.js";
import { acquireInflightLock, InflightLockError } from "./lib/inflight-lock.js";
import { classifyFailure, MAX_TRANSIENT_RETRIES, type FailureSignal } from "./lib/classify.js";
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

/** Arm GitHub auto-merge on a PR the runner opened. Non-fatal: the poll decides. */
function armAutoMerge(prUrl: string): void {
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
 * Poll the PR's `ci` check to a terminal state BEFORE the review runs (Standing
 * rule 4: the reviewer judges ACCEPTANCE only once the code is proven to typecheck
 * and its tests pass). Returns "green" on ci success, "red" on any red conclusion,
 * "timeout" if ci never resolves — pending is never treated as pass.
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
    const roll = v.statusCheckRollup ?? [];
    const red = roll.find((c) => RED_CONCLUSIONS.has(String(c.conclusion ?? c.state ?? "")));
    if (red) return "red";
    const ci = roll.find((c) => (c.name ?? c.context) === "ci");
    if (ci && String(ci.conclusion ?? ci.state ?? "") === "SUCCESS") return "green";
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
}): Promise<ReviewVerdict & { headSha: string }> {
  const { owner, repo, prUrl, task, report, log, say } = args;
  const view = ghJson(["pr", "view", prUrl, "--json", "headRefOid"]) as { headRefOid: string };
  const headSha = view.headRefOid;
  const diff = execFileSync("gh", ["pr", "diff", prUrl], { encoding: "utf8", maxBuffer: 1 << 26 });
  const criteria = task.acceptance ?? [];

  // Advisory semantic layer — a FRESH read-only reviewer (no session inheritance),
  // in a throwaway cwd so it cannot touch the worktree/diff under review.
  let semantic: (boolean | undefined)[] | undefined;
  if (args.spawnReviewer !== false && criteria.length > 0) {
    try {
      const reviewCwd = mkdtempSync(join(tmpdir(), "rmd-review-"));
      const prompt =
        buildReviewPrompt({ task: { id: task.id, acceptance: criteria }, prUrl, owner, repo, headSha }) +
        "\n" +
        reviewerVerdictContract(criteria.length);
      const reviewer = args.account(
        await spawnWorker({
          cwd: reviewCwd,
          permissionMode: "bypassPermissions",
          settingsFile: args.settingsFile,
          maxTurns: 12,
          maxBudgetUsd: args.budgetUsd,
          config: args.config,
          prompt, // NEVER resumeSessionId, NEVER forkSession — fresh by construction.
        }),
      );
      semantic = parseReviewerVerdicts(
        [reviewer.text, reviewer.blocks.join("\n")].join("\n"),
        criteria.length,
      );
      log("review.reviewer", {
        session_id: reviewer.sessionId,
        subtype: reviewer.subtype,
        downgrades: semantic.filter((s) => s === false).length,
        // W1-T6: the advisory reviewer is a BRAIN-PLANE call — same telemetry
        // shape as a worker call, so ledger lines are queryable uniformly.
        ...workerLedgerFields(reviewer),
      });
    } catch (e) {
      // Advisory only — the deterministic floor still binds and posts below.
      log("review.reviewer.error", { error: String((e as Error)?.message ?? e) });
    }
  }

  // BINDING deterministic verdict; the orchestrator is the authoritative poster.
  const verdict = judgeReview(criteria, { diff, report, semantic });
  postReviewStatus({ owner, repo, sha: headSha, state: verdict.state, description: verdict.summary });
  const unmet = verdict.criteria.filter((c) => !c.met);
  const unmetClaims = unmet.map((c) => c.claim);
  const reasons = unmet.map((c) => c.reason);
  if (verdict.testTheater) reasons.push("test theater: added tests assert nothing");
  // The gate TEACHES: the FULL list of unmet criteria goes to the ledger (and the
  // PR comment below) — the status description names only the first (length-capped).
  log("review.posted", {
    context: REVIEW_CONTEXT,
    state: verdict.state,
    head_sha: headSha,
    test_theater: verdict.testTheater,
    unmet_criteria: unmetClaims,
    reasons,
  });
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
  say(`remudero-review=${verdict.state} posted to ${headSha.slice(0, 7)} — ${verdict.summary}`);
  return { ...verdict, headSha };
}

export interface RunResult {
  taskId: string;
  runId: string;
  prUrl?: string;
  merged: boolean;
  costUsd: number;
  verdict:
    | "merged"
    | "blocked"
    | "blocked_ci"
    | "blocked_review"
    | "blocked_budget"
    | "blocked_containment"
    | "blocked_inflight"
    | "no_pr"
    | "blocked_transient"
    | "failed";
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
 * Render the implement prompt: cited CONTEXT + TASK + explicit output contract.
 *
 * `learningsContext` is the Promptsmith READ side (W1-T19): the distrust rule,
 * the autonomy clause, and the task-matched LEARNINGS facts — each already
 * provenance-tagged, so the whole CONTEXT block still lints clean.
 */
export function renderImplementPrompt(
  task: Task,
  reconContext: string,
  runId: string,
  learningsContext = "",
): string {
  const contextClaims = (task.context ?? [])
    .map((c) => `- ${c.claim} ${citation(c.src)}`)
    .join("\n");
  const body = (task.prompt ?? task.title)
    .split("${RUN_ID}").join(runId)
    .split("${TASK_ID}").join(task.id);

  return [
    "# CONTEXT",
    learningsContext,
    contextClaims,
    reconContext,
    "",
    "# TASK",
    body,
    "",
    "# OUTPUT CONTRACT",
    "- Make ONLY the change described in TASK; one concern.",
    "- If a filename/approach choice is needed, FIRST emit a DECISION_REQUEST",
    "  (exactly two options, one marked RECOMMENDED, a reversibility note) and STOP.",
    "- Otherwise: stage the changed file(s), commit with a concise message, then run",
    "  `git push origin HEAD` (NOT `-u` — the shared .git/config is outside the sandbox",
    "  write scope, WS-0 FF10f), and open a PR with `gh pr create --fill --base main`.",
    `- Include this exact trailer as the LAST line of the PR body: Remudero-Task: ${task.id}`,
    "- End with a REPORT whose LAST line is exactly: PR_URL: <the pull request url>",
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

async function runTask(taskId: string, opts: { planPath?: string; config?: Config } = {}): Promise<RunResult> {
  const config = opts.config ?? loadConfig();
  const planPath = opts.planPath ?? join(repoRoot, "plan", "tasks.yaml");
  const ledgerPath = join(config.root, "state", "ledger.ndjson");
  const owner = resolveOwner();

  const plan: Plan = loadPlan(planPath);
  const task = selectTask(plan, taskId);

  // ── Merge-state is DERIVED FROM GITHUB, never from the yaml `status:` field
  // (MASTER-PLAN v2.1). Project the whole plan against GitHub, cache it to a
  // machine-owned status.json, and gate on the derived merged predicate. The
  // runner NEVER writes tasks.yaml.
  const statusPath = join(config.root, "state", "status.json");
  const projection = projectPlan(
    plan,
    { ledgerPath: join(config.root, "state", "ledger.ndjson"), github: ghGateway(owner, task.repo) },
    statusPath,
  );
  const isMerged = (t: Task): boolean => projection.get(t.id)?.merged ?? false;
  assertRunnable(plan, task, isMerged); // refuse unmerged deps / blocked / verify:human

  const runId = `${taskId}-${Date.now()}`;
  const log = (step: string, extra: Record<string, unknown> = {}) =>
    appendLedger(ledgerPath, { run_id: runId, task_id: taskId, step, ...extra });
  const say = (msg: string) => console.log(`\n### [${taskId}] ${msg}`);

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
  const mount: Mount = resolveMount(loadMounts(mountsPath(repoRoot)), task.type, task.risk);
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
    const recon = account(
      await spawnWorker({
        cwd: worktreePath,
        permissionMode: "bypassPermissions",
        settingsFile,
        maxTurns: 8, // recon is read-only + bounded; turns stay tight here.
        maxBudgetUsd: budgetUsd, // dollars are the real backstop (WS-0 knob a).
        config,
        prompt:
          "You are a RECON worker. Do NOT modify anything. Inspect the current git " +
          "repository read-only (git remote -v, git log --oneline -5, ls). Output one report:\n" +
          "RECON REPORT\nOBSERVED: <commands + key output>\nINFERRED: <conclusions>\n" +
          "COULDN'T-VERIFY: <unconfirmed>",
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

    // ── Promptsmith READ side (W1-T19): inject the distrust rule, the autonomy
    // clause, and the task-matched LEARNINGS facts. Matching is deterministic by
    // file-glob; the KNOWLEDGE BUDGET caps the injected facts and DROPPED entries
    // are logged so a growing corpus never becomes an unbounded context tax.
    const learnings = loadLearnings(join(dirname(planPath), "learnings.yaml"));
    const { selected, dropped } = selectLearnings(learnings, task.files, DEFAULT_KNOWLEDGE_BUDGET_CHARS);
    const learningsContext = renderLearningsContext(selected);
    log("learnings.injected", {
      matched: selected.length,
      dropped: dropped.map((d) => d.id),
      budget_chars: DEFAULT_KNOWLEDGE_BUDGET_CHARS,
    });

    // ── Render + provenance-lint the prompt.
    const reconContext = reconObservedToContext(recon, taskId);
    const prompt = renderImplementPrompt(task, reconContext, runId, learningsContext);
    assertProvenance(prompt); // throws ProvenanceError on any uncited CONTEXT claim
    log("prompt.linted", { provenance: "clean" });
    say("prompt provenance-linted: clean");

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
      appendFileSync(
        join(repoRoot, "DECISIONS.md"),
        `\n## ${new Date().toISOString()} — ${taskId} (${runId})\n` +
          `- Options: ${decision.options.join(" | ")}\n` +
          `- Chosen (RECOMMENDED, auto): ${chosen}\n` +
          `- Rollback: revert the PR.\n`,
      );
      log("decision.autochoose", { chosen });
      say(`DECISION_REQUEST auto-chose: ${chosen}`);
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
    const review = await runReview({
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
    });
    if (review.state !== "success") {
      log("verdict", {
        verdict: "blocked_review",
        pr_url: prUrl,
        reason: review.summary,
        cost_usd: costUsd,
        billing_mode: "subscription",
      });
      say(`verdict: blocked_review — PR left OPEN: ${prUrl}`);
      return { taskId, runId, prUrl, merged: false, costUsd, verdict: "blocked_review" };
    }

    // ── ARM auto-merge, then POLL to the gate (W1-T1B).
    // The runner NEVER force-merges: it arms GitHub auto-merge on the PR it just
    // opened against main, then observes. GitHub merges only when the required
    // check is green. If checks go red or the poll times out, the PR is LEFT
    // OPEN and the verdict is blocked_ci — pending is treated as blocked, never
    // as pass. No Action arms a PR; only this code, only on PRs it opened.
    armAutoMerge(prUrl);
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

async function reviewCommand(prArg: string, rest: string[] = []): Promise<number> {
  // `--repo <name>` or `--repo <owner>/<name>` lets the runner post remudero-review to a
  // repo OTHER than this checkout (e.g. remudero-sandbox for the daemon's live commissioning,
  // W1-T12d). Without it, resolveOwnerRepo() pins to repoRoot's origin (the main repo) and
  // `gh pr view` resolves the PR in the CWD — so a sandbox PR could never be gated. The lib
  // layer (runReview / postReviewStatus) already takes owner+repo; only the CLI was pinned.
  const { owner, repo } = resolveReviewTarget(resolveOwnerRepo(), rest);
  const slug = `${owner}/${repo}`;
  const view = ghJson(["pr", "view", prArg, "--repo", slug, "--json", "headRefOid,body,url,number"]) as {
    headRefOid: string;
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
  const verdict = await runReview({
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
  });
  console.log(
    `\nremudero-review=${verdict.state} posted to ${view.url} (head ${verdict.headSha.slice(0, 7)})`,
  );
  return verdict.state === "success" ? 0 : 1;
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
  const gather = buildGather({
    ledgerNdjson,
    learningsMd,
    sinceTs: marker?.ts,
    learningsAtMarker: marker?.learnings_count,
  });
  const report = renderGather(gather);

  if (dryRun) {
    console.log(report);
    return 0;
  }

  // G-17 Tier Invariant: the retro Architect MUST outrank implement workers.
  const arch = architectModel(config);
  const wrk = workerModel(config);
  assertArchitectAboveWorker(arch, wrk); // throws (fail-closed) on violation

  const { owner, repo } = resolveOwnerRepo();
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

  const prompt = retroPrompt(report, calibrationTable(gather.byType), runId);
  try {
    const worker = await spawnWorker({
      cwd: worktreePath,
      permissionMode: "bypassPermissions",
      settingsFile,
      model: arch, // the Architect tier
      maxTurns: 40,
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

    // Ensure the branch reached origin (worker pushes without -u).
    let onOrigin = false;
    try {
      execFileSync("git", ["-C", worktreePath, "ls-remote", "--exit-code", "origin", branch], { stdio: "ignore" });
      onOrigin = true;
    } catch {
      onOrigin = false;
    }
    if (!onOrigin) execFileSync("git", ["-C", worktreePath, "push", "origin", "HEAD"], { stdio: "inherit" });

    let prUrl = parseReport([worker.text, worker.blocks.join("\n")].join("\n"))?.prUrl;
    if (!prUrl) {
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
    ensureTaskTrailer(prUrl, "RETRO");

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
    armAutoMerge(prUrl);
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
 * `rmd drain [--until <id>] [--max <n>] [--dry-run]` — drain the DAG through the
 * EXISTING run-task path. Thin + deterministic: next-runnable is the plan.ts DAG
 * logic over GitHub-derived status; it STOPS ON ANY BLOCK (v1); it is headroom-aware
 * and bounded. See lib/drain.ts for the loop; this only wires the real defaults.
 */
async function drainCommand(rest: string[]): Promise<number> {
  // FAIL LOUD on junk args BEFORE touching config/locks/spawns (a malformed control command
  // must spawn NOTHING — the daemon-install hazard). drain takes only these flags.
  const badArg = unknownArgError("drain", rest, ["--until", "--max"], ["--dry-run"]);
  if (badArg) {
    console.error(badArg + "\n" + USAGE);
    return 2;
  }
  const dryRun = rest.includes("--dry-run");
  const untilIdx = rest.indexOf("--until");
  const maxIdx = rest.indexOf("--max");
  const opts: DrainOpts = {
    until: untilIdx >= 0 ? rest[untilIdx + 1] : undefined,
    max: maxIdx >= 0 ? Number(rest[maxIdx + 1]) : DRAIN_DEFAULT_MAX,
  };
  const config = loadConfig();
  const planPath = join(repoRoot, "plan", "tasks.yaml");
  const ledgerPath = join(config.root, "state", "ledger.ndjson");
  const statusPath = join(config.root, "state", "status.json");
  const { owner } = resolveOwnerRepo();
  const plan = loadPlan(planPath);

  // Merged predicate, re-derived from GitHub each call (status.ts). The plan is
  // stewarded in `remudero`, so the gateway targets it; cross-repo tasks resolve
  // via the ledger's full pr_url (deriveStatus source (a)) or are verify:human.
  const refreshMerged: () => MergedSet = () => {
    const proj = projectPlan(
      plan,
      { ledgerPath, github: ghGateway(owner, "remudero") },
      statusPath,
    );
    return (id: string) => proj.get(id)?.merged ?? false;
  };

  if (dryRun) {
    const seq = plannedSequence(plan, refreshMerged(), opts);
    console.log(`### rmd drain --dry-run — ${seq.length} task(s) would run, in order:`);
    seq.forEach((id, i) => console.log(`  ${i + 1}. ${id}`));
    if (seq.length === 0) console.log("  (nothing runnable — deps unmet, all merged, or --until already satisfied)");
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

  const runId = `DRAIN-${Date.now()}`;
  const log = (step: string, extra: Record<string, unknown> = {}) =>
    appendLedger(ledgerPath, { run_id: runId, task_id: "DRAIN", step, ...extra });
  log("drain.start", { until: opts.until ?? null, max: opts.max, lock_pid: drainLock.info.pid });

  try {
    const summary = await runDrain(
      plan,
      {
        refreshMerged,
        runOne: (taskId) => runTask(taskId, { planPath, config }),
        readUsage: () => readUsageSnapshot(config),
        checkStop: () => stopDetail(config.root),
        checkPause: () => pauseDetail(config.root),
        log,
      },
      opts,
    );
    console.log("\n" + renderSummary(summary));
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
 * "nothing runnable right now" — it paces itself with a real `setTimeout`
 * sleep and keeps polling, since new work can land later. It DOES still stop
 * on STOP, PAUSE, headroom-exhausted, a block (v1 stop-on-block — reasoning
 * about the block is W1-T46), or an unexpected error.
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
  const badArg = unknownArgError("daemon", rest, ["--max", "--poll-ms"]);
  if (badArg) {
    console.error(badArg + "\n" + USAGE);
    return 2;
  }
  const maxIdx = rest.indexOf("--max");
  const pollIdx = rest.indexOf("--poll-ms");
  const opts: DaemonOpts = {
    max: maxIdx >= 0 ? Number(rest[maxIdx + 1]) : undefined,
    pollIntervalMs: pollIdx >= 0 ? Number(rest[pollIdx + 1]) : DEFAULT_POLL_INTERVAL_MS,
  };
  const config = loadConfig();
  const planPath = join(repoRoot, "plan", "tasks.yaml");
  const ledgerPath = join(config.root, "state", "ledger.ndjson");
  const statusPath = join(config.root, "state", "status.json");
  const { owner } = resolveOwnerRepo();
  const plan = loadPlan(planPath);

  const refreshMerged: () => MergedSet = () => {
    const proj = projectPlan(
      plan,
      { ledgerPath, github: ghGateway(owner, "remudero") },
      statusPath,
    );
    return (id: string) => proj.get(id)?.merged ?? false;
  };

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

  const runId = `DAEMON-${Date.now()}`;
  const log = (step: string, extra: Record<string, unknown> = {}) =>
    appendLedger(ledgerPath, { run_id: runId, task_id: "DAEMON", step, ...extra });
  log("daemon.start", { max: opts.max ?? null, poll_interval_ms: opts.pollIntervalMs, lock_pid: drainLock.info.pid });
  // ANTHROPIC-clean-env boot assertion (W1-T12b): checked once, before the loop
  // starts, over the daemon process's OWN live env — belt-and-suspenders atop
  // the launchd unit's own closed EnvironmentVariables allowlist (lib/launchd.ts).
  daemonBoot(log);

  try {
    const summary = await runDaemon(
      plan,
      {
        refreshMerged,
        runOne: (taskId) => runTask(taskId, { planPath, config }),
        readUsage: () => readUsageSnapshot(config),
        checkStop: () => stopDetail(config.root),
        checkPause: () => pauseDetail(config.root),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        log,
      },
      opts,
    );
    console.log("\n" + renderDaemonSummary(summary));
    // Exit 0 only on a clean stop (STOP requested / max reached); a block,
    // headroom exhaustion, or error is a non-zero exit so a supervising
    // wrapper (or launchd, W1-T12b) notices.
    return summary.stopReason === "stopped" || summary.stopReason === "max_reached" ? 0 : 1;
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
  const config = loadConfig();
  const pollIdx = rest.indexOf("--poll-ms");
  const pollIntervalMs = pollIdx >= 0 ? Number(rest[pollIdx + 1]) : undefined;
  const rmdBin = join(repoRoot, "bin", "rmd");
  const plist = generateLaunchdPlist({ rmdBin, root: config.root, pollIntervalMs });
  const plistPath = launchdPlistPath();

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
    console.error(
      'usage: rmd escalate --class <BLOCKED|MANUAL|HARD_STOP> --task <id> --summary <s> [--detail <d>] [--recommendation <r>] [--option "label|detail"]...',
    );
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
    console.error("usage: rmd notify <message>");
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

// ── CLI entry (invoked by bin/rmd). Kept tiny; all logic is above/lib.
const USAGE =
  "usage:\n  rmd run-task <task-id>\n  rmd review <pr-number>   # post remudero-review on a hand-opened PR\n  rmd retro [--dry-run]    # sync the plan from the ledger (Architect retro)\n  rmd drain [--until <id>] [--max <n>] [--dry-run]   # drain the DAG through run-task\n  rmd daemon [--max <n>] [--poll-ms <n>]   # persistent scheduler loop (STOP/PAUSE/headroom-aware)\n  rmd daemon-plist [--poll-ms <n>] [--write]   # generate the launchd unit for `rmd daemon` (commissioning is W1-T12d)\n  rmd stop [--reason <text>]    # fleet control: ONE-SHOT halt of the RUNNING drain; auto-clears when that run ends (no resume needed). No-op if nothing is running.\n  rmd pause [--reason <text>]   # fleet control: PERSISTENT drain-and-hold — in-flight completes, no new spawns; survives across runs until `rmd resume`.\n  rmd resume                    # fleet control: clear PAUSE (and any STOP); spawns resume\n  rmd escalate --class <BLOCKED|MANUAL|HARD_STOP> --task <id> --summary <s> [--detail <d>] [--recommendation <r>] [--option \"label|detail\"]...\n  rmd notify <message>     # real-time iMessage ping (osascript)\n  rmd digest [--since <iso>] [--dry-run]   # roll up the ledger into one daily digest message\n  rmd init [--tier <pro|max5x|max20x>] [--yes]   # headless-safe first-run tier wizard\n\nAn UNKNOWN command, or an unrecognized argument to a command, prints this usage and exits\nNON-ZERO, spawning nothing — the control surface never falls through to a drain on bad input.";

// ── CLI entry (invoked by bin/rmd). Kept tiny; all logic is above/lib.
async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  const arg = rest[0];
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(USAGE);
    process.exit(0);
  }
  if (cmd === "run-task" && arg) {
    const result = await runTask(arg);
    console.log("\n" + JSON.stringify(result, null, 2));
    process.exit(result.merged ? 0 : 1);
  }
  if (cmd === "review" && arg) {
    process.exit(await reviewCommand(arg, rest.slice(1)));
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
  if (cmd === "stop") {
    process.exit(await stopCommand(rest));
  }
  if (cmd === "pause") {
    process.exit(await pauseCommand(rest));
  }
  if (cmd === "resume") {
    process.exit(await resumeFleetCommand());
  }
  if (cmd === "escalate") {
    process.exit(await escalateCommand(rest));
  }
  if (cmd === "notify") {
    process.exit(await notifyCommand(rest));
  }
  if (cmd === "digest") {
    process.exit(await digestCommand(rest));
  }
  if (cmd === "init") {
    process.exit(await initCommand(rest));
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

export { runTask, runReview, waitForCiGreen, reviewCommand, retroCommand, initCommand };
