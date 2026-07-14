import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { query, type Options, type PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig, workerShell, workerZdotdir, type Config } from "./config.js";
import { buildWorkerEnv } from "./env.js";

/** Structured result of one worker run. */
export interface WorkerResult {
  sessionId: string;
  costUsd: number;
  /**
   * Turns the worker actually took (SDK `num_turns` off the result envelope).
   * Recorded on BOTH success and error paths — a run's turn count is telemetry
   * that seeds mounts.yaml calibration (W1-T5), so a failed run is never `0`.
   */
  numTurns: number;
  /** Final result text (the `result` field of the SDK result message). */
  text: string;
  /** All assistant text blocks concatenated, in order. */
  blocks: string[];
  /** Everything the child wrote to stderr — proof surface for the billing boundary. */
  stderr: string;
  /** Result subtype: 'success' | 'error_max_turns' | 'error_max_budget_usd' | … */
  subtype: string;
  isError: boolean;
  /** Permission denials the SDK surfaced (hook/permission blocks). */
  permissionDenials: unknown[];
  /** The exact env the child was spawned with (billing-boundary proof). */
  childEnvKeys: string[];
}

export interface SpawnWorkerArgs {
  cwd: string;
  permissionMode: PermissionMode;
  /** Path to the worker settings file (permissions + hooks + sandbox). */
  settingsFile: string;
  prompt: string;
  /** Resume an existing session (auto-choose round-trip, fix rounds). */
  resumeSessionId?: string;
  /** Extra env vars merged into the allowlisted child env (never ANTHROPIC_*). */
  env?: Record<string, string>;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  config?: Config;
}

/**
 * Spawn one headless Claude Code worker via the Agent SDK.
 *
 * Uses the installed SDK's isolation options as ground truth (SDK 0.3.209):
 *  - `pathToClaudeCodeExecutable` → the absolute binary from config (never PATH).
 *  - `env` → REPLACES the subprocess env entirely (per the SDK contract), so the
 *    allowlisted, ANTHROPIC-stripped env from buildWorkerEnv() is the billing
 *    boundary. No wholesale process.env inheritance.
 *  - `settings` → the worker settings file (permissions + hooks).
 *  - `settingSources: []` → SDK isolation mode; never loads ~/.claude/settings.json.
 *  - `sandbox` → parsed from the settings file and passed as the validated SDK
 *    option, so a malformed sandbox block fails loud instead of the CLI silently
 *    dropping an invalid settings file and running unsandboxed.
 */
export async function spawnWorker(args: SpawnWorkerArgs): Promise<WorkerResult> {
  const config = args.config ?? loadConfig();
  // Shell isolation (resolved from config, never hardcoded) so a worker sources
  // no operator rc: CLAUDE_CODE_SHELL redirects Claude Code's Bash-tool snapshot
  // to an empty rc, ZDOTDIR covers any direct zsh (W1-T1C compinit contamination).
  const childEnv = buildWorkerEnv(args.env ?? {}, process.env, {
    zdotdir: workerZdotdir(config),
    shell: workerShell(config),
  });

  const stderrChunks: string[] = [];
  const blocks: string[] = [];

  // NOTE (SDK 0.3.209 ground truth): passing BOTH a `settings` file path and the
  // `sandbox` option throws "Cannot use both …". The sandbox config therefore
  // lives inside the settings file; the probe (verdict 7) empirically confirms
  // it actually engaged rather than being silently dropped.
  const options: Options = {
    cwd: args.cwd,
    permissionMode: args.permissionMode,
    pathToClaudeCodeExecutable: config.claudeBin,
    env: childEnv,
    settings: args.settingsFile,
    settingSources: [],
    stderr: (data: string) => {
      stderrChunks.push(data);
    },
  };
  if (args.resumeSessionId) options.resume = args.resumeSessionId;
  if (args.model) options.model = args.model;
  if (typeof args.maxTurns === "number") options.maxTurns = args.maxTurns;
  if (typeof args.maxBudgetUsd === "number") options.maxBudgetUsd = args.maxBudgetUsd;

  return collectWorkerResult(query({ prompt: args.prompt, options }), {
    childEnvKeys: Object.keys(childEnv).sort(),
    stderrChunks,
  });
}

/**
 * Reduce the SDK message stream into a {@link WorkerResult}. Extracted from
 * spawnWorker so the error-envelope behavior is unit-testable without spawning
 * a real worker.
 *
 * CRITICAL (SDK 0.3.209 ground truth, WS-1 root cause): the SDK still YIELDS the
 * `type:"result"` envelope for an error subtype (error_max_turns,
 * error_max_budget_usd, …) — carrying `num_turns` and `total_cost_usd` — and
 * only THEN throws `Error("Claude Code returned an error result: …")` from the
 * iterator. If that throw escapes, the run's cost + turns are lost and a failed
 * run looks FREE in the ledger. So: once a result envelope is seen, the trailing
 * throw is swallowed and the captured envelope is returned with isError=true. A
 * throw with NO result envelope is a genuine transport/spawn failure — re-raised.
 */
export async function collectWorkerResult(
  messages: AsyncIterable<unknown>,
  opts: { childEnvKeys: string[]; stderrChunks?: string[] },
): Promise<WorkerResult> {
  const blocks: string[] = [];
  const stderrChunks = opts.stderrChunks ?? [];

  let sessionId = "";
  let costUsd = 0;
  let numTurns = 0;
  let text = "";
  let subtype = "";
  let isError = false;
  let permissionDenials: unknown[] = [];
  let sawResult = false;

  try {
    for await (const raw of messages) {
      const msg = raw as { type?: string; message?: unknown };
      if (msg.type === "assistant") {
        const content = (msg.message as { content?: unknown }).content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && (block as { type?: string }).type === "text") {
              blocks.push((block as { text: string }).text);
            }
          }
        }
      } else if (msg.type === "result") {
        const r = raw as {
          subtype: string;
          is_error: boolean;
          result?: string;
          session_id: string;
          total_cost_usd: number;
          num_turns?: number;
          permission_denials?: unknown[];
        };
        sawResult = true;
        subtype = r.subtype;
        isError = r.is_error;
        text = r.result ?? "";
        sessionId = r.session_id;
        costUsd = r.total_cost_usd;
        numTurns = typeof r.num_turns === "number" ? r.num_turns : 0;
        permissionDenials = r.permission_denials ?? [];
      }
    }
  } catch (err) {
    // No result envelope was seen ⇒ this is a real failure (bad binary, network,
    // aborted spawn), not an error-subtype result. Re-raise it.
    if (!sawResult) throw err;
    // Otherwise the throw is the SDK's post-error-result signal; the envelope is
    // already captured. Record the message on stderr for the proof surface.
    stderrChunks.push(
      `\n[collectWorkerResult] error-result throw swallowed: ${String((err as Error)?.message ?? err)}\n`,
    );
    isError = true;
  }

  return {
    sessionId,
    costUsd,
    numTurns,
    text,
    blocks,
    stderr: stderrChunks.join(""),
    subtype,
    isError,
    permissionDenials,
    childEnvKeys: opts.childEnvKeys,
  };
}

/**
 * Render the committed worker-settings TEMPLATE into a concrete settings file.
 *
 * The template ships `${HOOKS_DIR}` in its hook command so the public tree
 * carries no absolute machine path. At runtime we substitute the real hooks dir
 * and write the result outside the tree (workers run with cwd = a worktree, so
 * the hook path must be absolute, not `$CLAUDE_PROJECT_DIR`-relative). Returns
 * the path to the rendered file.
 */
export function renderWorkerSettings(opts: {
  templatePath: string;
  hooksDir: string;
  outPath: string;
}): string {
  const template = readFileSync(opts.templatePath, "utf8");
  const rendered = template.split("${HOOKS_DIR}").join(opts.hooksDir);
  // Validate JSON before writing so a bad substitution fails loud (a settings
  // file that fails validation is SILENTLY ignored by `claude -p`).
  JSON.parse(rendered);
  mkdirSync(join(opts.outPath, ".."), { recursive: true });
  writeFileSync(opts.outPath, rendered, { mode: 0o600 });
  return opts.outPath;
}

// ── Worker output-contract parsers ────────────────────────────────────────
// Parsed from the concatenated worker text. Malformed ⇒ caller decides on a
// reformat retry / strike (out of scope for the spike).

export interface ReconReport {
  observed: string;
  inferred: string;
  couldntVerify: string;
}

export interface Report {
  raw: string;
  prUrl?: string;
}

export interface DecisionRequest {
  raw: string;
  options: string[];
  recommended?: string;
}

export interface QuestionReport {
  raw: string;
  question: string;
}

/** Extract a labelled section (`HEADER:` … until the next known header). */
function section(text: string, header: string, stops: string[]): string {
  const re = new RegExp(
    `${header}\\s*:?\\s*\\n?([\\s\\S]*?)(?=\\n\\s*(?:${stops.join("|")})\\s*:|$)`,
    "i",
  );
  const m = text.match(re);
  return m ? m[1].trim() : "";
}

export function parseReconReport(text: string): ReconReport | null {
  if (!/RECON REPORT/i.test(text)) return null;
  return {
    observed: section(text, "OBSERVED", ["INFERRED", "COULDN'?T-?VERIFY"]),
    inferred: section(text, "INFERRED", ["COULDN'?T-?VERIFY"]),
    couldntVerify: section(text, "COULDN'?T-?VERIFY", []),
  };
}

export function parseReport(text: string): Report | null {
  if (!/(^|\n)\s*REPORT/i.test(text) || /RECON REPORT/i.test(text)) {
    if (!/PR_URL/i.test(text)) return null;
  }
  const prUrl = text.match(/https:\/\/github\.com\/[^\s)"']+\/pull\/\d+/)?.[0];
  return { raw: text, prUrl };
}

export function parseDecisionRequest(text: string): DecisionRequest | null {
  if (!/DECISION_REQUEST/i.test(text)) return null;
  const options = [
    ...new Set(
      [...text.matchAll(/^\s*(?:[-*]|\d+[.)])\s*(.+)$/gim)].map((m) => m[1].trim()),
    ),
  ];
  // Prefer an explicit `RECOMMENDED: <value>` line, but ignore a bare inline
  // `(RECOMMENDED)` marker (which would capture stray punctuation). Fall back to
  // the option line that carries the marker, with the marker stripped.
  let recommended = text.match(/^\s*RECOMMENDED\s*[:=]\s*(.+?)\s*$/im)?.[1]?.trim();
  if (!recommended || /^[)\].,;:]*$/.test(recommended)) {
    const marked = options.find((o) => /\(?\s*RECOMMENDED\s*\)?/i.test(o));
    recommended = marked?.replace(/\s*\(?\s*RECOMMENDED\s*\)?/i, "").trim();
  }
  return { raw: text, options, recommended };
}

export function parseQuestion(text: string): QuestionReport | null {
  if (!/(^|\n)\s*QUESTION/i.test(text)) return null;
  const question = text.match(/QUESTION\s*:?\s*(.+)/i)?.[1]?.trim() ?? "";
  return { raw: text, question };
}

// ── Worktree lifecycle (under config.root/worktrees) ──────────────────────

export function worktreesDir(config: Config): string {
  return join(config.root, "worktrees");
}

/** `git worktree add` a fresh branch off origin/<base> for a repo checkout. */
export function worktreeAdd(
  repoDir: string,
  worktreePath: string,
  branch: string,
  base = "origin/main",
): void {
  execFileSync("git", ["-C", repoDir, "fetch", "origin", "--quiet"], { stdio: "inherit" });
  execFileSync(
    "git",
    ["-C", repoDir, "worktree", "add", "-b", branch, worktreePath, base],
    { stdio: "inherit" },
  );
}

export function worktreeRemove(repoDir: string, worktreePath: string): void {
  execFileSync("git", ["-C", repoDir, "worktree", "remove", "--force", worktreePath], {
    stdio: "inherit",
  });
}

/** Summary of what a start-of-run prune reclaimed (ledgered for provenance). */
export interface PruneSummary {
  worktrees: string[];
  branches: string[];
}

/**
 * Reclaim leftovers from crashed prior runs so they cannot block this one.
 *
 * A run that dies without reaching its cleanup (WS-1: max-turns run died with the
 * worktree + branch still on disk) leaves a `run-*` worktree and local branch
 * behind. `git worktree add -b run-…` for a NEW run has a unique timestamp so it
 * never collides — but the debris accumulates and a stale branch name could later
 * clash. At run start we force-remove every `run-*` worktree, `git worktree prune`
 * the admin records, then delete every remaining local `run-*` branch. All
 * best-effort and per-item guarded: a repo with nothing to prune returns empties.
 * The caller's own about-to-be-created branch does not exist yet, so it is safe.
 */
export function pruneStaleRuns(repoDir: string, worktreesRoot: string): PruneSummary {
  const removedWorktrees: string[] = [];
  const removedBranches: string[] = [];

  // 1. Force-remove any registered worktree whose path is under our worktrees
  //    root and whose branch is a run-* branch.
  let list = "";
  try {
    list = execFileSync("git", ["-C", repoDir, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
    });
  } catch {
    list = "";
  }
  let curPath = "";
  for (const line of list.split("\n")) {
    if (line.startsWith("worktree ")) curPath = line.slice("worktree ".length).trim();
    else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim(); // e.g. refs/heads/run-…
      const isRun = /\/run-/.test(ref) || ref.startsWith("run-");
      if (isRun && curPath.startsWith(worktreesRoot)) {
        try {
          execFileSync("git", ["-C", repoDir, "worktree", "remove", "--force", curPath], {
            stdio: "pipe",
          });
          removedWorktrees.push(curPath);
        } catch {
          // best-effort
        }
      }
    }
  }

  // 2. Prune admin records for worktrees whose directory is already gone.
  try {
    execFileSync("git", ["-C", repoDir, "worktree", "prune"], { stdio: "pipe" });
  } catch {
    // best-effort
  }

  // 3. Delete every remaining local run-* branch (now detached from any worktree).
  let branches = "";
  try {
    branches = execFileSync(
      "git",
      ["-C", repoDir, "for-each-ref", "--format=%(refname:short)", "refs/heads/run-*"],
      { encoding: "utf8" },
    );
  } catch {
    branches = "";
  }
  for (const b of branches.split("\n").map((s) => s.trim()).filter(Boolean)) {
    try {
      execFileSync("git", ["-C", repoDir, "branch", "-D", b], { stdio: "pipe" });
      removedBranches.push(b);
    } catch {
      // A branch still checked out in a worktree we couldn't remove — leave it.
    }
  }

  return { worktrees: removedWorktrees, branches: removedBranches };
}

// ── gh helpers (run outside the sandbox; TLS fails under Seatbelt) ─────────

export function ghJson(args: string[]): unknown {
  const out = execFileSync("gh", args, { encoding: "utf8" });
  return JSON.parse(out);
}

export function ghPrView(prUrl: string): { state: string; mergeable: string; url: string } {
  return ghJson(["pr", "view", prUrl, "--json", "state,mergeable,url"]) as {
    state: string;
    mergeable: string;
    url: string;
  };
}

export function ghPrMergeSquash(prUrl: string): string {
  return execFileSync("gh", ["pr", "merge", prUrl, "--squash", "--delete-branch"], {
    encoding: "utf8",
  });
}
