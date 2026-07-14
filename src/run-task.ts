import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, softBudgetThreshold, type Config } from "./lib/config.js";
import { appendLedger } from "./lib/ledger.js";
import {
  assertRunnable,
  loadPlan,
  selectTask,
  type AcceptanceCriterion,
  type Plan,
  type Task,
} from "./lib/plan.js";
import { ContainmentError, probeContainment } from "./lib/containment.js";
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
  ghJson,
  parseDecisionRequest,
  parseQuestion,
  parseReconReport,
  parseReport,
  pruneStaleRuns,
  renderWorkerSettings,
  spawnWorker,
  worktreeAdd,
  worktreeRemove,
  worktreesDir,
  type WorkerResult,
} from "./lib/worker.js";

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
  if (!r.isError) return null;
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
    },
  };
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

/** Render the implement prompt: cited CONTEXT + TASK + explicit output contract. */
function renderImplementPrompt(task: Task, reconContext: string, runId: string): string {
  const contextClaims = (task.context ?? [])
    .map((c) => `- ${c.claim} ${citation(c.src)}`)
    .join("\n");
  const body = (task.prompt ?? task.title)
    .split("${RUN_ID}").join(runId)
    .split("${TASK_ID}").join(task.id);

  return [
    "# CONTEXT",
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

  // Budget is a RUNAWAY TRIPWIRE, not an allowance (§9). The HARD cap defaults to
  // DEFAULT_BUDGET_USD ($100 — an order of magnitude above any observed task) when a
  // task omits it; the SOFT threshold ($25 default, config-tunable) only surfaces an
  // anomaly as a WARNING and never kills.
  const budgetUsd = task.budget_usd ?? DEFAULT_BUDGET_USD;
  const softThresholdUsd = softBudgetThreshold(config);
  log("run.start", { repo: task.repo, type: task.type, budget_usd: budgetUsd, soft_threshold_usd: softThresholdUsd });
  say(`run ${runId} — target ${owner}/${task.repo}`);

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
  const pruned = pruneStaleRuns(repoDir, worktreesDir(config));
  if (pruned.worktrees.length || pruned.branches.length) {
    log("worktree.prune", { worktrees: pruned.worktrees, branches: pruned.branches });
    say(`pruned ${pruned.worktrees.length} stale worktree(s), ${pruned.branches.length} branch(es)`);
  }

  const branch = `run-${runId}`;
  const worktreePath = join(worktreesDir(config), branch);
  worktreeAdd(repoDir, worktreePath, branch, "origin/main");
  log("worktree.add", { branch, worktreePath });

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
    });
    const reconFail = failOnWorkerError(recon, "recon");
    if (reconFail) return reconFail;

    // ── Render + provenance-lint the prompt.
    const reconContext = reconObservedToContext(recon, taskId);
    const prompt = renderImplementPrompt(task, reconContext, runId);
    assertProvenance(prompt); // throws ProvenanceError on any uncited CONTEXT claim
    log("prompt.linted", { provenance: "clean" });
    say("prompt provenance-linted: clean");

    // ── Implement.
    say("implement worker");
    let impl = account(
      await spawnWorker({
        cwd: worktreePath,
        permissionMode: "bypassPermissions",
        // maxTurns is a runaway-LOOP guard now, not a work limit — dollars
        // (maxBudgetUsd) are the real backstop. WS-1: an 18-turn cap killed a
        // legitimate ~6-minute implement run. 60 gives real work room; a run
        // that hits it is genuinely looping.
        maxTurns: 60,
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
      permission_denials: impl.permissionDenials.length,
    });
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
          maxTurns: 60, // same runaway guard as the initial implement spawn.
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
      });
      const resumeFail = failOnWorkerError(impl, "implement.resumed");
      if (resumeFail) return resumeFail;
    }

    // ── QUESTION contract (non-blocking) — log, don't stall (§2).
    const question = parseQuestion(fullText(impl));
    if (question) {
      appendFileSync(
        join(repoRoot, "plan", "questions.ndjson"),
        JSON.stringify({ ts: new Date().toISOString(), task: taskId, question: question.question }) + "\n",
      );
      log("question.logged", { question: question.question.slice(0, 120) });
    }

    // ── PR (worker REPORT or orchestrator fallback).
    let prUrl = parseReport(fullText(impl))?.prUrl;
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
  }
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
async function reviewCommand(prArg: string): Promise<number> {
  const { owner, repo } = resolveOwnerRepo();
  const view = ghJson(["pr", "view", prArg, "--json", "headRefOid,body,url,number"]) as {
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

// ── CLI entry (invoked by bin/rmd). Kept tiny; all logic is above/lib.
async function main(): Promise<void> {
  const [, , cmd, arg] = process.argv;
  if (cmd === "run-task" && arg) {
    const result = await runTask(arg);
    console.log("\n" + JSON.stringify(result, null, 2));
    process.exit(result.merged ? 0 : 1);
  }
  if (cmd === "review" && arg) {
    process.exit(await reviewCommand(arg));
  }
  console.error("usage:\n  rmd run-task <task-id>\n  rmd review <pr-number>   # post remudero-review on a hand-opened PR");
  process.exit(2);
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error("\n### RUN-TASK ERROR\n" + (err?.stack ?? String(err)));
    process.exit(1);
  });
}

export { runTask, runReview, waitForCiGreen, reviewCommand };
