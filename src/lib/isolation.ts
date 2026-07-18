import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type Config } from "./config.js";
import { spawnWorker, type SpawnWorkerArgs } from "./worker.js";

/**
 * ISOLATION PREFLIGHT PROBE (W1-T17 / Standing rule 11 / FIELD FINDING 11b).
 *
 * PR #8's shell isolation (CLAUDE_CODE_SHELL redirecting the Bash-tool snapshot
 * to an empty rc) works ONLY because THIS host's `~/.bashrc` happens to be
 * absent — an accident of the machine, not construction. A populated
 * `~/.bashrc` on some other host would silently isolate NOTHING (the config
 * "should" isolate, but that is a hypothesis, never a guarantee). Standing rule
 * 11: isolation is PROVEN PER RUN by probe, never assumed from configuration.
 *
 * This module is the empirical half: before any task worker runs, spawn a
 * READ-ONLY worker that counts the shell aliases/functions it inherited
 * (`alias | wc -l`, `declare -F | wc -l`). A worker with clean isolation
 * inherits NEITHER — any nonzero count means it picked up operator shell
 * state, so isolation is not holding on THIS run, THIS host. FAIL CLOSED
 * (Standing rule 11): a nonzero count aborts the run before any task work
 * begins, never a warning.
 *
 * GRANULARITY — once per run, mirroring containment.ts (W1-T2): the shell
 * config that determines contamination (CLAUDE_CODE_SHELL, ZDOTDIR, the host's
 * dotfiles) is constant across every spawn in a run, so the fact proven once
 * holds for all of them.
 *
 * READ-ONLY BY CONSTRUCTION, not just by prompt discipline: the probe spawn
 * restricts the model's tool set to `["Bash"]` ({@link isolationProbeSpawnArgs}),
 * so Write/Edit/NotebookEdit/MultiEdit are never even in the model's context —
 * a probe that is merely instructed to be read-only could still attempt a
 * write; one that never HAS a write tool cannot.
 *
 * CLAUDE-CODE'S OWN TOOL WRAPPERS ARE NOT OPERATOR STATE (CLI ≥ 2.1.211, verified
 * live this cycle). Every Claude Code Bash session injects a small, FIXED set of
 * shell FUNCTIONS into its snapshot that shadow `find`/`grep`/`rg` with Claude
 * Code's embedded `bfs`/`ugrep`/`ripgrep` binaries (the snapshot literally reads
 * `# Shadow find/grep with embedded bfs/ugrep`, `_cc_bin=$CLAUDE_CODE_EXECPATH`).
 * These are the SAME for every user on every host — they are the tool's own
 * plumbing, NOT operator shell customization — so counting them as "leakage" is a
 * FALSE POSITIVE that would block every run on a modern CLI. The probe therefore
 * counts only functions OUTSIDE {@link CLAUDE_CODE_TOOL_WRAPPERS}. This does NOT
 * weaken the invariant: an operator function of ANY OTHER name still trips the
 * gate, and an operator's own `find`/`grep`/`rg` function can never survive into
 * a worker anyway — Claude Code's snapshot `unalias`es and re-`function`s those
 * three names on top of whatever the shell had. Aliases are counted RAW (Claude
 * Code injects none). A wrapper name Claude Code adds in a FUTURE version is not
 * on this list, so it counts as operator state and fails CLOSED — the drift is
 * surfaced, never silently absorbed.
 */

/**
 * Claude Code's OWN Bash-tool wrapper function names (CLI ≥ 2.1.211) — excluded
 * from the isolation function count because they are the tool's plumbing, not
 * operator shell state (see file header). Kept deliberately SMALL and explicit:
 * a name not on this list is treated as operator leakage (fail closed).
 */
export const CLAUDE_CODE_TOOL_WRAPPERS = ["find", "grep", "rg"] as const;

/** Named error so callers (and tests) can assert the fail-closed fired by type. */
export class IsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IsolationError";
  }
}

/** Raw evidence gathered from one probe execution under the worker shell. */
export interface IsolationEvidence {
  /** `alias | wc -l` as reported by the probe worker (NaN if unparseable). */
  aliasCount: number;
  /** `declare -F | wc -l` as reported by the probe worker (NaN if unparseable). */
  functionCount: number;
  /**
   * The NAMES of the inherited aliases (space-joined) when the probe reported
   * them; omitted when the report carried no `alias_names:` line (an OLD-prompt
   * worker) or listed none. OBSERVABILITY ONLY — never consulted by the verdict.
   */
  aliasNames?: string;
  /**
   * The NAMES of the inherited functions (space-joined, find/grep/rg wrappers
   * excluded to match the count); omitted when unreported or none. Observability
   * only — the fail-closed decision is still purely the counts.
   */
  functionNames?: string;
}

/**
 * PURE verdict over probe evidence. Isolation holds IFF BOTH counts are
 * exactly zero. A count that could not be parsed out of the transcript is
 * NaN, which fails every comparison below — an unparseable report is treated
 * as UNPROVEN, not as a pass (absence of a bad number is not proof of a good
 * one; the same "unproven ⇒ fail closed" posture as containment.ts).
 */
export function assessIsolation(e: IsolationEvidence): { isolated: boolean; reason: string } {
  if (!Number.isFinite(e.aliasCount) || !Number.isFinite(e.functionCount)) {
    return {
      isolated: false,
      reason: "the probe's alias/function counts could not be parsed — isolation UNPROVEN",
    };
  }
  if (e.aliasCount > 0 || e.functionCount > 0) {
    // Observability (the W1-T91(i) direction, NOT completing that task): NAME the
    // inherited state so one line replaces a diagnostics session. The `[names]`
    // suffix appears ONLY when the probe reported names; absent ⇒ the reason is
    // byte-identical to the count-only version a worker on the old prompt produces.
    const named = (names?: string) => (names ? ` [${names}]` : "");
    return {
      isolated: false,
      reason:
        `worker inherited ${e.aliasCount} alias(es)${named(e.aliasNames)} and ${e.functionCount} function(s)${named(e.functionNames)} from operator ` +
        "shell state — isolation is NOT holding on this host/run",
    };
  }
  return {
    isolated: true,
    reason: `worker reports 0 aliases and 0 functions inherited (alias=${e.aliasCount}, functions=${e.functionCount})`,
  };
}

/** What one probe execution returns to the verdict layer. */
export interface ProbeExecResult {
  transcript: string;
  aliasCount: number;
  functionCount: number;
  /** Inherited alias names (space-joined) when the probe reported them; omitted otherwise. */
  aliasNames?: string;
  /** Inherited function names (space-joined, wrappers excluded) when reported; omitted otherwise. */
  functionNames?: string;
  /** Notional cost of the probe spawn (subscription) — surfaced so the run meters it. */
  costUsd?: number;
}

/** Injectable probe runner (default spawns a real worker); tests provide a fake. */
export type ProbeExecutor = () => Promise<ProbeExecResult>;

/** The probe worker prompt: report inherited alias/function counts, read-only.
 * The function count EXCLUDES Claude Code's own {@link CLAUDE_CODE_TOOL_WRAPPERS}
 * (find/grep/rg) — those are tool plumbing, not operator state (see file header).
 * `awk` is used for the filter because it is NOT one of the wrapped commands. */
export function isolationProbePrompt(): string {
  const wrappers = CLAUDE_CODE_TOOL_WRAPPERS.join("|");
  return [
    "You are an ISOLATION PREFLIGHT PROBE. READ-ONLY: use ONLY the Bash tool to run",
    "these commands, IN ORDER, and report the EXACT results. Do NOT create,",
    "modify, or delete any file — you have no write tool available for a reason.",
    "1) alias | wc -l        (count of shell aliases this worker inherited)",
    `2) declare -F | awk '$NF !~ /^(${wrappers})$/ {c++} END {print c+0}'`,
    `   (count of shell functions this worker inherited, EXCLUDING Claude Code's`,
    `    OWN find/grep/rg tool wrappers — those are injected into every Claude Code`,
    `    Bash session and are NOT operator shell state)`,
    `3) alias | awk '{sub(/^alias /, ""); sub(/=.*/, ""); printf "%s ", $0}'`,
    "   (the NAMES of those aliases, space-separated — empty output means none)",
    `4) declare -F | awk '$NF !~ /^(${wrappers})$/ {printf "%s ", $NF}'`,
    `   (the NAMES of those functions, the SAME find/grep/rg exclusion as command 2`,
    "    — empty output means none)",
    "End with exactly:",
    "REPORT",
    "aliases: <exact number from command 1>",
    "functions: <exact number from command 2>",
    "alias_names: <exact names from command 3, or - if command 3 printed nothing>",
    "function_names: <exact names from command 4, or - if command 4 printed nothing>",
  ].join("\n");
}

/** Matches the probe's `aliases: N` / `functions: N` report lines, in order. */
const REPORT_RE = /aliases:\s*(\d+)[\s\S]*?functions:\s*(\d+)/i;
/** Optional name lines (added alongside the counts) — matched TOLERANTLY: a worker
 * on the OLD prompt emits neither, and parsing is unchanged when they are absent. */
const ALIAS_NAMES_RE = /alias_names:\s*(.+)/i;
const FUNCTION_NAMES_RE = /function_names:\s*(.+)/i;

/** Normalize a reported names line to a space-joined display string, or `undefined`
 * when the line was absent, a literal `-`, or (for functions) left with only wrappers.
 * `excludeWrappers` re-applies the CLAUDE_CODE_TOOL_WRAPPERS filter in code so the
 * names honor the SAME exclusion as the count regardless of what the worker emitted. */
function normalizeNames(raw: string | undefined, excludeWrappers: boolean): string | undefined {
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "-") return undefined;
  let names = trimmed.split(/\s+/).filter((n) => n && n !== "-");
  if (excludeWrappers) {
    const wrappers = new Set<string>(CLAUDE_CODE_TOOL_WRAPPERS);
    names = names.filter((n) => !wrappers.has(n));
  }
  return names.length ? names.join(" ") : undefined;
}

/**
 * Parse the probe transcript into raw counts (and, when present, the inherited
 * NAMES); `null` if the report never appeared. The name fields are added to the
 * result ONLY when the probe reported them, so an old-prompt report parses to the
 * exact same `{ aliasCount, functionCount }` shape as before.
 */
export function parseIsolationReport(
  transcript: string,
): { aliasCount: number; functionCount: number; aliasNames?: string; functionNames?: string } | null {
  const m = REPORT_RE.exec(transcript);
  if (!m) return null;
  const aliasNames = normalizeNames(ALIAS_NAMES_RE.exec(transcript)?.[1], false);
  const functionNames = normalizeNames(FUNCTION_NAMES_RE.exec(transcript)?.[1], true);
  const out: { aliasCount: number; functionCount: number; aliasNames?: string; functionNames?: string } = {
    aliasCount: Number(m[1]),
    functionCount: Number(m[2]),
  };
  if (aliasNames) out.aliasNames = aliasNames;
  if (functionNames) out.functionNames = functionNames;
  return out;
}

/**
 * PURE builder for the probe worker's spawn args — extracted so the
 * read-only-by-construction guarantee (`tools: ["Bash"]`, no Write/Edit/
 * NotebookEdit/MultiEdit ever in context) is unit-testable without spawning a
 * real worker.
 */
export function isolationProbeSpawnArgs(opts: {
  cwd: string;
  settingsFile: string;
  budgetUsd?: number;
}): SpawnWorkerArgs {
  return {
    cwd: opts.cwd,
    permissionMode: "bypassPermissions",
    settingsFile: opts.settingsFile,
    // Structural read-only enforcement (belt-and-suspenders over the prompt):
    // the model has NO write tool at all, so it cannot use one even if asked.
    tools: ["Bash"],
    maxTurns: 4, // two read-only commands + the report; bounded tight.
    maxBudgetUsd: opts.budgetUsd,
    prompt: isolationProbePrompt(),
  };
}

/** Default executor: spawn a real worker in a scratch cwd under the workspace. */
function defaultExecutor(settingsFile: string, config: Config, budgetUsd?: number): ProbeExecutor {
  return async () => {
    const cwd = join(config.root, "tmp", `isolation-probe-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
    try {
      const probe = await spawnWorker({
        ...isolationProbeSpawnArgs({ cwd, settingsFile, budgetUsd }),
        config,
      });
      const transcript = [probe.text, probe.blocks.join("\n"), probe.stderr].join("\n");
      const parsed = parseIsolationReport(transcript);
      return {
        transcript,
        aliasCount: parsed?.aliasCount ?? NaN,
        functionCount: parsed?.functionCount ?? NaN,
        aliasNames: parsed?.aliasNames,
        functionNames: parsed?.functionNames,
        costUsd: probe.costUsd,
      };
    } finally {
      try {
        rmSync(cwd, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  };
}

/**
 * Run the isolation preflight for a run. FAILS CLOSED (throws
 * {@link IsolationError}) unless zero inherited aliases/functions is
 * empirically proven — before any task worker (recon/implement) runs.
 */
export async function probeIsolation(opts: {
  settingsFile: string;
  config?: Config;
  budgetUsd?: number;
  log?: (step: string, extra?: Record<string, unknown>) => void;
  /** Injectable for tests; default spawns a real worker. */
  exec?: ProbeExecutor;
}): Promise<{ isolated: true; reason: string; evidence: IsolationEvidence; costUsd: number }> {
  const log = opts.log ?? (() => {});
  const exec = opts.exec ?? defaultExecutor(opts.settingsFile, opts.config ?? loadConfig(), opts.budgetUsd);

  const r = await exec();
  const evidence: IsolationEvidence = { aliasCount: r.aliasCount, functionCount: r.functionCount };
  // Names are observability-only; carry them only when the probe reported them.
  if (r.aliasNames) evidence.aliasNames = r.aliasNames;
  if (r.functionNames) evidence.functionNames = r.functionNames;
  const verdict = assessIsolation(evidence);
  const costUsd = r.costUsd ?? 0;
  log("isolation.probe", {
    isolated: verdict.isolated,
    reason: verdict.reason,
    alias_count: evidence.aliasCount,
    function_count: evidence.functionCount,
    alias_names: evidence.aliasNames ?? null,
    function_names: evidence.functionNames ?? null,
    cost_usd: costUsd,
  });
  if (!verdict.isolated) {
    // Named error carrying the OBSERVED count (W1-T17 acceptance #1) AND, when the
    // probe reported them, the OBSERVED names — logged as its own ledger event,
    // distinct from the run-level `verdict` line the caller (run-task.ts) appends
    // when it converts this throw into a terminal run outcome.
    log("isolation_preflight_failed", {
      alias_count: evidence.aliasCount,
      function_count: evidence.functionCount,
      alias_names: evidence.aliasNames ?? null,
      function_names: evidence.functionNames ?? null,
      reason: verdict.reason,
    });
    throw new IsolationError(`isolation_preflight_failed: ${verdict.reason} — FAIL CLOSED, the run does not proceed`);
  }
  return { isolated: true, reason: verdict.reason, evidence, costUsd };
}
