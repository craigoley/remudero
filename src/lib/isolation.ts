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
 */

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
    return {
      isolated: false,
      reason:
        `worker inherited ${e.aliasCount} alias(es) and ${e.functionCount} function(s) from operator ` +
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
  /** Notional cost of the probe spawn (subscription) — surfaced so the run meters it. */
  costUsd?: number;
}

/** Injectable probe runner (default spawns a real worker); tests provide a fake. */
export type ProbeExecutor = () => Promise<ProbeExecResult>;

/** The probe worker prompt: report inherited alias/function counts, read-only. */
export function isolationProbePrompt(): string {
  return [
    "You are an ISOLATION PREFLIGHT PROBE. READ-ONLY: use ONLY the Bash tool to run",
    "these TWO commands, IN ORDER, and report the EXACT numbers. Do NOT create,",
    "modify, or delete any file — you have no write tool available for a reason.",
    "1) alias | wc -l        (count of shell aliases this worker inherited)",
    "2) declare -F | wc -l   (count of shell functions this worker inherited)",
    "End with exactly:",
    "REPORT",
    "aliases: <exact number from command 1>",
    "functions: <exact number from command 2>",
  ].join("\n");
}

/** Matches the probe's `aliases: N` / `functions: N` report lines, in order. */
const REPORT_RE = /aliases:\s*(\d+)[\s\S]*?functions:\s*(\d+)/i;

/** Parse the probe transcript into raw counts; `null` if the report never appeared. */
export function parseIsolationReport(transcript: string): { aliasCount: number; functionCount: number } | null {
  const m = REPORT_RE.exec(transcript);
  if (!m) return null;
  return { aliasCount: Number(m[1]), functionCount: Number(m[2]) };
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
  const verdict = assessIsolation(evidence);
  const costUsd = r.costUsd ?? 0;
  log("isolation.probe", {
    isolated: verdict.isolated,
    reason: verdict.reason,
    alias_count: evidence.aliasCount,
    function_count: evidence.functionCount,
    cost_usd: costUsd,
  });
  if (!verdict.isolated) {
    // Named error carrying the OBSERVED count (W1-T17 acceptance #1) — logged
    // as its own ledger event, distinct from the run-level `verdict` line the
    // caller (run-task.ts) appends when it converts this throw into a terminal
    // run outcome.
    log("isolation_preflight_failed", {
      alias_count: evidence.aliasCount,
      function_count: evidence.functionCount,
      reason: verdict.reason,
    });
    throw new IsolationError(`isolation_preflight_failed: ${verdict.reason} — FAIL CLOSED, the run does not proceed`);
  }
  return { isolated: true, reason: verdict.reason, evidence, costUsd };
}
