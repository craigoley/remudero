import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { query, type Options, type PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig, type Config } from "./config.js";
import { buildWorkerEnv } from "./env.js";

/** Structured result of one worker run. */
export interface WorkerResult {
  sessionId: string;
  costUsd: number;
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
  const childEnv = buildWorkerEnv(args.env ?? {});

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

  let sessionId = "";
  let costUsd = 0;
  let text = "";
  let subtype = "";
  let isError = false;
  let permissionDenials: unknown[] = [];

  for await (const msg of query({ prompt: args.prompt, options })) {
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
      const r = msg as {
        subtype: string;
        is_error: boolean;
        result?: string;
        session_id: string;
        total_cost_usd: number;
        permission_denials?: unknown[];
      };
      subtype = r.subtype;
      isError = r.is_error;
      text = r.result ?? "";
      sessionId = r.session_id;
      costUsd = r.total_cost_usd;
      permissionDenials = r.permission_denials ?? [];
    }
  }

  return {
    sessionId,
    costUsd,
    text,
    blocks,
    stderr: stderrChunks.join(""),
    subtype,
    isError,
    permissionDenials,
    childEnvKeys: Object.keys(childEnv).sort(),
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
