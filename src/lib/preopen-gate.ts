/**
 * THE HARNESS ASKS THE FAST GATE BEFORE IT OPENS A BUILD'S PULL REQUEST.
 *
 * A worker's own `rmd preflight --fast` is advisory: `preflightFailureNotice` only reports it. On
 * 2026-10-09 four fleet builds opened PRs carrying reds that gate names in seconds — #10482
 * (depcruise cycle, bound-kind, ledger-rotation, reach ratchet), #10491 (catch-erasure,
 * ledger-rotation, reach ratchet), #10516 (env-registry) — and each cost one or more fix rounds.
 * This module runs the same gate as a child process (never on the daemon's event loop), reads its
 * durable summary back, and names the failing steps so the worker can be handed them before the PR
 * opens.
 *
 * Only the census/ratchet fast gate runs here, not the selector's neighbouring suites: those take
 * minutes per build and already run under CI; the fast gate is the set a build can satisfy alone.
 */
import { execFile } from "node:child_process";
import { execFileLoopBounded } from "./loop-bounded-child.js";
import { accessSync, constants as fsConstants, existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CHILD_ENTRY_SPAWNED_STEP, childEntryArgv, childEntrySpawnedRow } from "./child-entry-argv.js";
import { preflightSummaryPath } from "./ci-parity.js";
import { systemClock, type Clock } from "./clock.js";
import { loadConfig } from "./config.js";
import { appendLedger } from "./ledger.js";
import { ledgerPathFor } from "./ledger-path.js";

export const PREOPEN_GATE_STEP = "implement.preopen_gate";

/** BACKSTOP only: a gate that has not answered by then is reported unmeasured, never a pass. */
export const PREOPEN_GATE_BACKSTOP_MS = 15 * 60_000;

export type PreopenGateResult =
  | { kind: "pass"; durationMs: number }
  | { kind: "fail"; failedSteps: string[]; durationMs: number }
  | { kind: "unmeasured"; reason: string; durationMs: number; deadlineEnforcedBy?: GateDeadlineEnforcer };

/**
 * W1-T9556 — who ended a gate at its backstop: coreutils `timeout` (needs no node loop), the deadline runner
 * (its own idle loop), or the parent's execFile timer (the daemon's loop — the last line, and the one a frozen
 * loop holds off).
 */
export type GateDeadlineEnforcer = "timeout" | "runner" | "parent";

export interface GateRun {
  exitCode: number | null;
  error?: string;
  /** Set when the backstop ended the gate: which enforcer did. */
  deadlineEnforcedBy?: GateDeadlineEnforcer;
}

export interface PreopenGateOptions {
  /** Runs the fast gate in `cwd`; resolves when the child exits, whatever its status. */
  runGate?: (cwd: string) => Promise<GateRun>;
  readFile?: (path: string) => string;
  clock?: Clock;
  /** W1-T8778: where `child_entry.spawned` goes. Default: the host ledger, best effort. Only the default `runGate` writes it. */
  log?: GateLog;
}

export type GateLog = (step: string, extra?: Record<string, unknown>) => void;

/** The default `child_entry.spawned` writer: one ledger row, and a failure to write it is noted, never the gate's failure. */
export const ledgerGateLog: GateLog = (step, extra = {}) => {
  try {
    appendLedger(ledgerPathFor(loadConfig()), { run_id: `PREOPEN-GATE-${process.pid}`, task_id: "HARNESS", step, lane: "harness", ...extra });
  } catch (error) {
    process.stderr.write(`preopen gate: could not ledger ${step}: ${String((error as Error)?.message ?? error).slice(0, 120)}\n`);
  }
};

/** The harness's own `bin/rmd` (the checkout this module runs from) — what gates a worktree with no `bin/rmd` of its own. */
export const HARNESS_RMD = fileURLToPath(new URL("../../bin/rmd", import.meta.url));

/**
 * W1-T8920 — the command that runs the fast gate for `cwd`. A worktree holding its own `bin/rmd` (the
 * harness's repo) spawns it, as always; a consumer worktree has none, so the harness's rmd is run with
 * `--repo-root <cwd>` instead of the spawn failing ENOENT and the build going unmeasured.
 */
export function preopenGateCommand(cwd: string, harnessRmd: string = HARNESS_RMD): { file: string; args: string[] } {
  const own = join(cwd, "bin", "rmd");
  if (existsSync(own)) return { file: own, args: ["preflight", "--fast"] };
  return { file: harnessRmd, args: ["preflight", "--fast", "--repo-root", cwd] };
}

const HARNESS_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * W1-T8778 — the command that runs the fast gate: the precompiled run-task entry under plain node when
 * childEntryArgv finds one current (the worktree's own for a harness-repo build, the harness's for a consumer
 * worktree, which keeps its `--repo-root`), else {@link preopenGateCommand}'s `bin/rmd`, which starts tsx.
 * `child_entry.spawned` records which ran and why.
 */
export function preopenGateLaunch(
  cwd: string, log: GateLog = ledgerGateLog, harnessRmd: string = HARNESS_RMD, harnessRoot: string = HARNESS_ROOT,
  rowExtra: Record<string, unknown> = {},
): { file: string; args: string[] } {
  const own = existsSync(join(cwd, "bin", "rmd"));
  const root = own ? cwd : harnessRoot;
  const launch = childEntryArgv(root, "run-task", "src/run-task.ts", own ? ["preflight", "--fast"] : ["preflight", "--fast", "--repo-root", cwd], undefined, { log });
  log(CHILD_ENTRY_SPAWNED_STEP, { ...childEntrySpawnedRow("run-task", "preflight --fast", launch), ...rowExtra });
  return launch.kind === "bundle" ? { file: process.execPath, args: launch.argv } : preopenGateCommand(cwd, harnessRmd);
}

/** W1-T9556: the plain-node runner that holds the gate's deadline on its own loop and kills the gate's process group. */
export const DEADLINE_RUNNER = fileURLToPath(new URL("../../scripts/run-with-deadline.mjs", import.meta.url));
/** Mirrors scripts/run-with-deadline.mjs: a deadline kill's exit status (coreutils `timeout`'s too) and its stderr line. */
export const GATE_DEADLINE_EXIT_CODE = 124;
export const GATE_DEADLINE_MARKER = "rmd-deadline-exceeded";
/** How long a group signalled SIGTERM at the deadline has to leave before it is SIGKILLed. A teardown grace, not a bound on the gate. */
export const GATE_KILL_GRACE_MS = 5_000;

/** A PATH lookup with no spawn: the first executable `name` on `pathEnv`, or `null`. */
export function findOnPath(name: string, pathEnv: string | undefined = process.env.PATH): string | null {
  for (const dir of (pathEnv ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here (absent or not executable): the next PATH entry is the answer, and none at all means `null`.
    }
  }
  return null;
}

let resolvedTimeoutBin: string | null | undefined;
/** coreutils `timeout`, resolved once per process; `null` where it is absent (macOS dev hosts). */
export function gateTimeoutBin(): string | null {
  if (resolvedTimeoutBin === undefined) resolvedTimeoutBin = findOnPath("timeout");
  return resolvedTimeoutBin;
}

/** Which enforcers are armed for a launch, outermost-first: what `child_entry.spawned` records as `deadline_enforced_by`. */
export function armedEnforcers(timeoutBin: string | null): GateDeadlineEnforcer[] {
  return timeoutBin ? ["timeout", "runner", "parent"] : ["runner", "parent"];
}

/** The runner argv that runs `file args` under an absolute `deadlineAt`, with coreutils `timeout` inside when present. */
export function deadlineRunnerArgs(file: string, args: readonly string[], deadlineAt: number, timeoutBin: string | null, runner: string = DEADLINE_RUNNER): string[] {
  return [runner, String(deadlineAt), String(GATE_KILL_GRACE_MS), ...(timeoutBin ? ["--kernel-timeout", timeoutBin] : []), "--", file, ...args];
}

/** Classify a finished gate child: a backstop kill by any enforcer is "fast gate exceeded its backstop". */
export function classifyGateExit(error: (Error & { code?: unknown; killed?: boolean }) | null, stderr: string): GateRun {
  if (!error) return { exitCode: 0 };
  const code = typeof error.code === "number" ? error.code : null;
  if (error.killed === true) return { exitCode: code, error: "fast gate exceeded its backstop", deadlineEnforcedBy: "parent" };
  if (code === GATE_DEADLINE_EXIT_CODE) {
    const by = new RegExp(`${GATE_DEADLINE_MARKER} enforced_by=(timeout|runner)`).exec(stderr)?.[1] as GateDeadlineEnforcer | undefined;
    return { exitCode: code, error: "fast gate exceeded its backstop", deadlineEnforcedBy: by ?? "timeout" };
  }
  return { exitCode: code, ...(code === null ? { error: error.message } : {}) };
}

export interface RunGateDeadline {
  /** The backstop; default {@link PREOPEN_GATE_BACKSTOP_MS}. */
  backstopMs?: number;
  /** coreutils `timeout`, or `null` for none; default {@link gateTimeoutBin}. */
  timeoutBin?: string | null;
  /** Where the absolute deadline is read from; default the system clock. */
  clock?: Clock;
}

/**
 * `harnessRmd` given means the caller chose the launcher (tests): it is run as given and no bundle is considered.
 *
 * W1-T9556: the gate runs under scripts/run-with-deadline.mjs, so its deadline is held by a process whose loop is
 * idle — and by coreutils `timeout` inside it where present — rather than by this process's loop, which a sync
 * spawn or ledger read can freeze for minutes. execFile's own timeout stays as a third, later line.
 */
export function defaultRunGate(cwd: string, harnessRmd?: string, log?: GateLog, deadline: RunGateDeadline = {}): Promise<GateRun> {
  const backstopMs = deadline.backstopMs ?? PREOPEN_GATE_BACKSTOP_MS;
  const timeoutBin = deadline.timeoutBin === undefined ? gateTimeoutBin() : deadline.timeoutBin;
  const deadlineAt = (deadline.clock ?? systemClock).now() + backstopMs;
  const { file, args } = harnessRmd === undefined
    ? preopenGateLaunch(cwd, log, HARNESS_RMD, HARNESS_ROOT, { deadline_enforced_by: armedEnforcers(timeoutBin) })
    : preopenGateCommand(cwd, harnessRmd);
  return execFileLoopBounded(process.execPath, deadlineRunnerArgs(file, args, deadlineAt, timeoutBin),
    { cwd, encoding: "utf8", timeout: backstopMs + 2 * GATE_KILL_GRACE_MS, maxBuffer: 64 * 1024 * 1024 }).then(
    () => classifyGateExit(null, ""),
    (error: Error & { code?: unknown; killed?: boolean; stderr?: unknown }) => classifyGateExit(error, String(error.stderr ?? "")),
  );
}

/** The failing step names recorded by a summary written at or after `startedAt`, or why it can't be read. */
export function readGateSummary(
  worktreePath: string,
  startedAt: number,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): { failedSteps: string[] } | { unreadable: string } {
  let parsed: { ok?: unknown; finishedAt?: unknown; steps?: unknown };
  try {
    parsed = JSON.parse(readFile(preflightSummaryPath(worktreePath))) as typeof parsed;
  } catch (e) {
    return { unreadable: `no readable preflight summary (${(e as Error).message})` };
  }
  const finished = typeof parsed.finishedAt === "string" ? Date.parse(parsed.finishedAt) : NaN;
  if (!Number.isFinite(finished) || finished < startedAt) return { unreadable: "the preflight summary predates this gate run" };
  const steps = Array.isArray(parsed.steps) ? (parsed.steps as Array<{ name?: unknown; ok?: unknown }>) : [];
  const failedSteps = steps.filter((s) => s && s.ok === false).map((s) => (typeof s.name === "string" && s.name ? s.name : "(unnamed step)"));
  if (parsed.ok === false && failedSteps.length === 0) return { failedSteps: ["(summary reported FAIL with no step named)"] };
  return { failedSteps };
}

/** Run the fast gate in a build's worktree and classify the result. */
export async function runPreopenGate(worktreePath: string, deps: PreopenGateOptions = {}): Promise<PreopenGateResult> {
  const clock = deps.clock ?? systemClock;
  const now = () => clock.now();
  const startedAt = now();
  const run = await (deps.runGate ?? ((cwd) => defaultRunGate(cwd, undefined, deps.log)))(worktreePath);
  const durationMs = now() - startedAt;
  if (run.error !== undefined) {
    return { kind: "unmeasured", reason: run.error, durationMs, ...(run.deadlineEnforcedBy ? { deadlineEnforcedBy: run.deadlineEnforcedBy } : {}) };
  }
  const read = readGateSummary(worktreePath, startedAt, deps.readFile);
  if ("unreadable" in read) return { kind: "unmeasured", reason: read.unreadable, durationMs };
  if (read.failedSteps.length === 0) return { kind: "pass", durationMs };
  return { kind: "fail", failedSteps: read.failedSteps, durationMs };
}

/** The continuation prompt that hands a worker the fast-gate steps its tree fails. */
export function renderPreopenGatePrompt(failedSteps: readonly string[], harnessOwnsGit: boolean): string {
  return [
    "Before your pull request opens, the harness ran `rmd preflight --fast` on your tree and these steps FAILED:",
    ...failedSteps.map((s) => `  - ${s}`),
    "",
    "Fix each one in your own change (never by lowering a baseline your change did not move), then re-run",
    "`rmd preflight --fast` until it passes.",
    harnessOwnsGit
      ? "Leave your edits in the worktree; the harness commits them."
      : "Commit the fixes with a proper conventional-commit subject (not a wip checkpoint).",
  ].join("\n");
}
