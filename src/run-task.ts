import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "./lib/config.js";
import { appendLedger } from "./lib/ledger.js";
import {
  assertRunnable,
  loadPlan,
  selectTask,
  type Plan,
  type Task,
} from "./lib/plan.js";
import { assertProvenance, citation } from "./lib/provenance.js";
import { validateWorkerSettingsFile } from "./lib/settings.js";
import {
  ghPrMergeSquash,
  ghPrView,
  parseDecisionRequest,
  parseQuestion,
  parseReconReport,
  parseReport,
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
  const url = execFileSync("git", ["-C", repoRoot, "config", "--get", "remote.origin.url"], {
    encoding: "utf8",
  }).trim();
  const m = url.match(/[/:]([^/:]+)\/[^/]+?(?:\.git)?$/);
  if (!m) throw new Error(`could not parse owner from origin url`);
  return m[1];
}

export interface RunResult {
  taskId: string;
  runId: string;
  prUrl?: string;
  merged: boolean;
  costUsd: number;
  verdict: "merged" | "blocked" | "failed";
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
    "- End with a REPORT whose LAST line is exactly: PR_URL: <the pull request url>",
  ].join("\n");
}

async function runTask(taskId: string, opts: { planPath?: string; config?: Config } = {}): Promise<RunResult> {
  const config = opts.config ?? loadConfig();
  const planPath = opts.planPath ?? join(repoRoot, "plan", "tasks.yaml");
  const ledgerPath = join(config.root, "state", "ledger.ndjson");
  const owner = resolveOwner();

  const plan: Plan = loadPlan(planPath);
  const task = selectTask(plan, taskId);
  assertRunnable(plan, task); // refuse unmerged deps / blocked / verify:human

  const runId = `${taskId}-${Date.now()}`;
  const log = (step: string, extra: Record<string, unknown> = {}) =>
    appendLedger(ledgerPath, { run_id: runId, task_id: taskId, step, ...extra });
  const say = (msg: string) => console.log(`\n### [${taskId}] ${msg}`);

  log("run.start", { repo: task.repo, type: task.type, budget_usd: task.budget_usd });
  say(`run ${runId} — target ${owner}/${task.repo}`);

  let costUsd = 0;
  const account = (r: WorkerResult) => {
    costUsd += r.costUsd; // NOTIONAL on subscription — tripwire/meter only (FF10d)
    return r;
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

  // ── Clone + worktree.
  const repoDir = join(config.root, "repos", task.repo);
  if (!existsSync(repoDir)) {
    mkdirSync(dirname(repoDir), { recursive: true });
    execFileSync("gh", ["repo", "clone", `${owner}/${task.repo}`, repoDir], { stdio: "inherit" });
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
        maxTurns: 8,
        config,
        prompt:
          "You are a RECON worker. Do NOT modify anything. Inspect the current git " +
          "repository read-only (git remote -v, git log --oneline -5, ls). Output one report:\n" +
          "RECON REPORT\nOBSERVED: <commands + key output>\nINFERRED: <conclusions>\n" +
          "COULDN'T-VERIFY: <unconfirmed>",
      }),
    );
    log("recon.done", { session_id: recon.sessionId, cost_usd: recon.costUsd, subtype: recon.subtype });

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
        settingsFile,
        maxTurns: 18,
        config,
        prompt,
      }),
    );
    log("implement.done", {
      session_id: impl.sessionId,
      cost_usd: impl.costUsd,
      subtype: impl.subtype,
      permission_denials: impl.permissionDenials.length,
    });

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
          maxTurns: 18,
          config,
          prompt:
            `Decision made: ${chosen}. Now execute the change and the OUTPUT CONTRACT from before: ` +
            `commit, \`git push origin HEAD\` (no -u), open the PR with \`gh pr create --fill --base main\`, ` +
            `and end with a REPORT whose last line is exactly: PR_URL: <url>`,
        }),
      );
      log("implement.resumed", { session_id: impl.sessionId, cost_usd: impl.costUsd });
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
    log("pr.opened", { pr_url: prUrl });
    say(`PR: ${prUrl}`);

    // ── Poll + merge.
    let view = ghPrView(prUrl);
    for (let i = 0; i < 12 && view.mergeable !== "MERGEABLE" && view.state === "OPEN"; i++) {
      execFileSync("sleep", ["3"]);
      view = ghPrView(prUrl);
    }
    log("pr.mergeable", { mergeable: view.mergeable, state: view.state });
    ghPrMergeSquash(prUrl);
    const after = ghPrView(prUrl);
    const merged = after.state === "MERGED";
    log("pr.merged", { state: after.state });

    worktreeRemove(repoDir, worktreePath);
    log("worktree.remove", {});

    const verdict: RunResult["verdict"] = merged ? "merged" : "failed";
    log("verdict", { verdict, pr_url: prUrl, cost_usd: costUsd, billing_mode: "subscription" });
    say(`verdict: ${verdict} · notional cost $${costUsd.toFixed(4)}`);
    return { taskId, runId, prUrl, merged, costUsd, verdict };
  } catch (err) {
    log("run.error", { error: String((err as Error)?.message ?? err) });
    // Leave the worktree for post-mortem; surface the error.
    throw err;
  }
}

// ── CLI entry (invoked by bin/rmd). Kept tiny; all logic is above/lib.
async function main(): Promise<void> {
  const [, , cmd, taskId] = process.argv;
  if (cmd !== "run-task" || !taskId) {
    console.error("usage: rmd run-task <task-id>");
    process.exit(2);
  }
  const result = await runTask(taskId);
  console.log("\n" + JSON.stringify(result, null, 2));
  process.exit(result.merged ? 0 : 1);
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error("\n### RUN-TASK ERROR\n" + (err?.stack ?? String(err)));
    process.exit(1);
  });
}

export { runTask };
