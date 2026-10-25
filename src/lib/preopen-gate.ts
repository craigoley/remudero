/**
 * THE HARNESS ASKS THE FAST GATE BEFORE IT OPENS A BUILD'S PULL REQUEST.
 *
 * A worker's own `rmd preflight --fast` is advisory: `preflightFailureNotice` only reports it. On
 * 2026-10-09 four fleet builds opened PRs carrying reds that gate names in seconds — #10482
 * (depcruise cycle, bound-kind, ledger-rotation, reach ratchet), #10491 (catch-erasure,
 * ledger-rotation, reach ratchet), #10516 (env-registry) — and each cost one or more fix rounds.
 * This module runs the same gate as a child process (never on the daemon's event loop) and names the
 * failing steps so the worker can be handed them before the PR opens.
 *
 * Only the census/ratchet fast gate runs here, not the selector's neighbouring suites: those take
 * minutes per build and already run under CI; the fast gate is the set a build can satisfy alone.
 *
 * W1-T9619 — THE GATE RUNS TRUSTED CODE, CONTAINED, AND ITS VERDICT IS ONE THE HARNESS OBSERVED. The gate's
 * steps run scripts the worktree holds, unreviewed. So: the entry is always the harness's own code with
 * `--repo-root <worktree>` (never the worktree's bin/rmd or bundle); the child's environment is
 * {@link PREOPEN_GATE_ENV_ALLOWLIST} only; it runs in the review proof children's bubblewrap sandbox; and
 * pass or fail is the child's exit status. Step names come from a summary in a harness-made directory outside
 * the worktree; a `coverage/preflight-summary.json` inside the worktree is never read. No sandbox, no run:
 * the gate is unmeasured with the reason, never run with the daemon's environment.
 */
import { execFileSync } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { CHILD_ENTRY_SPAWNED_STEP, childEntryArgv, childEntrySpawnedRow } from "./child-entry-argv.js";
import { runPushGate, type PushGateOutcome } from "./git-push.js";
import { systemClock, type Clock } from "./clock.js";
import { loadConfig } from "./config.js";
import { appendLedger } from "./ledger.js";
import { ledgerPathFor } from "./ledger-path.js";
import { execFileLoopBounded } from "./loop-bounded-child.js";
import { PROOF_ENV_ALLOWLIST, PROOF_SANDBOX_BINARY, proofChildEnv, proofLinkedModuleRoots, proofSandboxArgv } from "./review.js";
import { TEST_SLOT_DIR_ENV, TEST_SLOTS_ENV } from "./test-slot.js";
import { RMD_TMP_PREFIX } from "./tmp.js";
import { parseGateSandboxMeasurement, type GateSandboxMeasurement } from "./gate-sandbox-metrics.js";
import { spoolEscalation, withdrawSpooledEscalation } from "./host-escalation-spool.js";

export const PREOPEN_GATE_STEP = "implement.preopen_gate";
export const PREOPEN_UNMEASURED_ALERT_AT = 3;

/** Fleet-wide consecutive gate observations, in ledger order; other steps do not interrupt it. */
export function detectUnmeasuredPreopenStreak(rows: readonly Record<string, unknown>[], threshold = PREOPEN_UNMEASURED_ALERT_AT) {
  let consecutive = 0;
  let firstTs: unknown;
  let firstRunId: unknown;
  let newestTs: unknown;
  let reason: unknown;
  for (const row of rows) {
    if (row.step !== PREOPEN_GATE_STEP) continue;
    if (row.result === "pass" || row.result === "fail") {
      consecutive = 0;
      firstTs = firstRunId = newestTs = reason = undefined;
    } else if (row.result === "unmeasured") {
      if (consecutive === 0) { firstTs = row.ts; firstRunId = row.run_id; }
      consecutive++;
      newestTs = row.ts;
      reason = row.reason;
    }
  }
  return { alert: consecutive >= threshold, consecutive, firstTs, firstRunId, newestTs, reason };
}

/** Called after the gate row is durable. Alert transport failure must never stop a build. */
export function updatePreopenGateAlert(opts: {
  stateDir: string;
  readRows: () => readonly Record<string, unknown>[];
  log: GateLog;
  clock?: Clock;
  host?: string;
}): void {
  try {
    const rows = opts.readRows();
    const streak = detectUnmeasuredPreopenStreak(rows);
    const prior = rows.findLast(row => row.step === `${PREOPEN_GATE_STEP}.alert` && (row.action === "raised" || row.action === "cleared"));
    const identity = { taskId: "HARNESS", summary: "fleet pre-open gates are unmeasured" };
    const meta = { source: PREOPEN_GATE_STEP, host: opts.host ?? "fleet", clock: opts.clock ?? systemClock };
    if (streak.alert && (prior?.action !== "raised" || prior.streak_first_ts !== streak.firstTs)) {
      spoolEscalation(opts.stateDir, {
        ...identity, class: "BLOCKED", runId: String(streak.firstRunId), headDedup: "independent",
        detail: `${streak.consecutive} consecutive pre-open gates were unmeasured across the fleet. ` +
          `First: ${streak.firstTs} (run ${streak.firstRunId}); newest: ${streak.newestTs}. Reason: ${streak.reason}`,
        options: [
          { label: "repair gate execution", detail: "inspect the named containment or backstop failure on the host and restore measured gates" },
          { label: "wait for recovery", detail: "builds continue; the next measured pass or fail clears this alert" },
        ],
        recommendation: "repair gate execution",
        consequence: "build pull requests continue opening without a measured local fast gate",
      }, meta);
      opts.log(`${PREOPEN_GATE_STEP}.alert`, { consecutive: streak.consecutive, streak_first_ts: streak.firstTs, action: "raised" });
    } else if (streak.consecutive === 0 && prior?.action === "raised") {
      withdrawSpooledEscalation(opts.stateDir, identity, "A pre-open gate was measured again (pass or fail); the unmeasured streak has ended.", meta);
      opts.log(`${PREOPEN_GATE_STEP}.alert`, { consecutive: 0, streak_first_ts: prior.streak_first_ts, action: "cleared" });
    }
  } catch (error) {
    opts.log(`${PREOPEN_GATE_STEP}.alert`, { action: "failed", reason: `could not update pre-open gate alert: ${String(error)}` });
  }
}

/** BACKSTOP only: a gate that has not answered by then is reported unmeasured, never a pass. */
export const PREOPEN_GATE_BACKSTOP_MS = 15 * 60_000;

/** W1-T9619: how a gate ran — inside the sandbox, or not at all because no sandbox could be built. */
export type GateContainmentMode = "sandboxed" | "unmeasured";

/** W1-T9602: what the harness push gate, asked after the fast gate, came to. */
export interface PreopenPushGate {
  outcome: PushGateOutcome["kind"];
  /** Wall time of the push gate alone; the result's own `durationMs` stays the fast gate's. */
  durationMs: number;
  reused?: boolean;
  reason?: string;
  key?: { tree: string; head: string; base: string; recipe: string };
}

export type PreopenGateResult = (
  | { kind: "pass"; durationMs: number; containment?: GateContainmentMode; pushGate?: PreopenPushGate }
  | { kind: "fail"; failedSteps: string[]; durationMs: number; containment?: GateContainmentMode; pushGate?: PreopenPushGate }
  | { kind: "unmeasured"; reason: string; durationMs: number; deadlineEnforcedBy?: GateDeadlineEnforcer; containment?: GateContainmentMode }
) & { sandboxMetrics?: GateSandboxMeasurement };

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
  /** W1-T9619: set by the default runner; an injected runner leaves it absent. */
  containment?: GateContainmentMode;
  /** W1-T9619: the failing steps read from the harness-owned summary, or why it could not be read. */
  summary?: GateSummary;
  sandboxMetrics?: GateSandboxMeasurement;
}

export type GateSummary = ({ failedSteps: string[] } | { unreadable: string }) & { sandboxMetrics?: GateSandboxMeasurement };

export interface PreopenGateOptions {
  /** Runs the fast gate in `cwd`; resolves when the child exits, whatever its status. */
  runGate?: (cwd: string) => Promise<GateRun>;
  readFile?: (path: string) => string;
  clock?: Clock;
  /** W1-T8778: where `child_entry.spawned` goes. Default: the host ledger, best effort. Only the default `runGate` writes it. */
  log?: GateLog;
  /** W1-T9619: the default runner's sandbox; default {@link defaultGateContainment}. */
  contain?: GateContain;
  /** W1-T9602: the harness push gate asked after the fast gate; default the push leaf's own {@link runPushGate}. */
  runPushGate?: (cwd: string) => Promise<PushGateOutcome>;
  /** W1-T10267: the procfs-write census asked of the changed test files; default {@link changedProcfsWriteOffences}. */
  scanProcfsWrites?: (cwd: string) => string[];
}

/** W1-T10267: fs entry points that block when handed a procfs path (same list as the W1-T3345 census). */
const PROCFS_WRITE_CALLS = ["mkdirSync", "mkdtempSync", "writeFileSync", "appendFileSync", "rmSync", "openSync", "createWriteStream", "cpSync"];
const PROCFS_WRITE_OPTION = /\b(?:dir|path|cwd|root|out|outDir)\s*:\s*["'`]\/proc\//;

/** W1-T10267: `file:line  text` for each line aiming a write-shaped call at procfs. Pure. */
export function procfsWriteOffences(files: readonly { name: string; text: string }[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    f.text.split("\n").forEach((raw, i) => {
      if (!raw.includes("/proc/")) return;
      if (PROCFS_WRITE_CALLS.some((c) => raw.includes(`${c}(`)) || PROCFS_WRITE_OPTION.test(raw)) out.push(`${f.name}:${i + 1}  ${raw.trim().slice(0, 120)}`);
    });
  }
  return out;
}

/** W1-T10267: scan the test files this branch changed against origin/main; an unreadable diff yields no offences (the hosted census still runs). */
export function changedProcfsWriteOffences(cwd: string): string[] {
  let names: string[];
  try {
    names = execFileSync("git", ["diff", "--name-only", "--diff-filter=AM", "origin/main...HEAD", "--", "test/"], { cwd, encoding: "utf8", timeout: 20_000 })
      .split("\n").filter((n) => n.endsWith(".test.ts") && !n.endsWith("no-test-aims-a-write-at-procfs.test.ts"));
  } catch {
    return [];
  }
  const files: { name: string; text: string }[] = [];
  for (const name of names) {
    try { files.push({ name, text: readFileSync(join(cwd, name), "utf8") }); } catch { /* deleted or unreadable: nothing to scan */ }
  }
  return procfsWriteOffences(files);
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

/** The harness's own `bin/rmd` (the checkout this module runs from): the gate's entry when no current bundle is. */
export const HARNESS_RMD = fileURLToPath(new URL("../../bin/rmd", import.meta.url));

/**
 * W1-T8920 / W1-T9619 — the command that runs the fast gate for `cwd`: the harness's rmd with `--repo-root <cwd>`,
 * for a consumer worktree and a core worktree alike. A worktree's own `bin/rmd` is never what runs.
 */
export function preopenGateCommand(cwd: string, harnessRmd: string = HARNESS_RMD, extraArgs: readonly string[] = []): { file: string; args: string[] } {
  return { file: harnessRmd, args: ["preflight", "--fast", "--repo-root", cwd, ...extraArgs] };
}

const HARNESS_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * W1-T8778 / W1-T9619 — the command that runs the fast gate: the HARNESS's precompiled run-task entry under plain
 * node when childEntryArgv finds one current, else {@link preopenGateCommand}'s harness `bin/rmd`, which starts tsx.
 * Either way `--repo-root <cwd>`. `child_entry.spawned` records which ran and why.
 */
export function preopenGateLaunch(
  cwd: string, log: GateLog = ledgerGateLog, harnessRmd: string = HARNESS_RMD, harnessRoot: string = HARNESS_ROOT,
  rowExtra: Record<string, unknown> = {}, extraArgs: readonly string[] = [],
): { file: string; args: string[] } {
  const launch = childEntryArgv(harnessRoot, "run-task", "src/run-task.ts", ["preflight", "--fast", "--repo-root", cwd, ...extraArgs], undefined, { log });
  log(CHILD_ENTRY_SPAWNED_STEP, { ...childEntrySpawnedRow("run-task", "preflight --fast", launch), ...rowExtra });
  return launch.kind === "bundle" ? { file: process.execPath, args: launch.argv } : preopenGateCommand(cwd, harnessRmd, extraArgs);
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

// ── W1-T9619: THE GATE CHILD'S ENVIRONMENT AND SANDBOX ───────────────────────────────────────────────────────────

/**
 * Every variable a gate child may receive: the review proof children's list (W1-T6124) plus the host test-slot
 * pair, so the gate's typecheck still queues on the host-wide slot (the Codex writer's precedent, codexTestSlotArgs:
 * lock records only, no credential). Nothing else crosses — GH_TOKEN, GH_APP_*, provider keys stay with the daemon.
 */
export const PREOPEN_GATE_ENV_ALLOWLIST = [...PROOF_ENV_ALLOWLIST, TEST_SLOT_DIR_ENV, TEST_SLOTS_ENV] as const;
/** The name the ledger records for the allowlist; never its values. */
export const PREOPEN_GATE_ENV_ALLOWLIST_NAME = "PREOPEN_GATE_ENV_ALLOWLIST";

/** The gate child's environment: {@link proofChildEnv} with HOME at `home`, the slot pair, and nothing off the allowlist. */
export function preopenGateEnv(home: string, parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = new Set<string>(PREOPEN_GATE_ENV_ALLOWLIST);
  const env: NodeJS.ProcessEnv = proofChildEnv(home, parent);
  for (const key of [TEST_SLOT_DIR_ENV, TEST_SLOTS_ENV]) if (typeof parent[key] === "string") env[key] = parent[key];
  for (const key of Object.keys(env)) if (!allowed.has(key) || env[key] === undefined) delete env[key];
  return env;
}

export interface GateContainInput {
  cwd: string;
  /** The throwaway HOME, which also holds the gate's summary. */
  home: string;
  harnessRoot: string;
  /** The child's environment ({@link preopenGateEnv}). */
  env: NodeJS.ProcessEnv;
}

/** A sandbox: run `file ...argv <command>`, where `argv` ends in `--`. Or why there is none. */
export type GateContainment = { mode: "sandboxed"; file: string; argv: string[] } | { mode: "unavailable"; reason: string };
export type GateContain = (input: GateContainInput) => GateContainment | Promise<GateContainment>;

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * The bubblewrap argv for a gate child: {@link proofSandboxArgv}'s (worktree, its gitdir and HOME writable;
 * runtime, git common dir with its config masked and node_modules targets read-only; no network) plus the
 * harness's code read-only with its `.git` masked (its config can carry a credential-bearing remote) and the
 * host test-slot dir writable. Extra binds go before the proof binds, so a deeper proof bind lands on top.
 *
 * A read-only proof bind of a path AT OR UNDER the harness is dropped: the harness bind already shows that path,
 * read-only, as the host has it. Kept, it broke every gate from 2026-10-17 03:43Z: a worker worktree's
 * `node_modules` links to the run's engine tree's (the harness), itself a link to the managed checkout's install
 * (W1-T9738), and W1-T9860 binds that middle hop. bwrap resolves the hop's source to the install but mounts onto
 * the hop's DESTINATION, which inside the sandbox is the harness's absolute symlink, so the mount fails ENOENT (PR 12595).
 */
/** End of the shared sandbox's /tmp mount and parent-directory prefix. Mount /tmp before
 * the extra harness binds, or a disk bind would hide a harness whose path is under /tmp. */
export function preopenSandboxBindStart(base: readonly string[]): number {
  const mount = base.findIndex((flag, i) => (flag === "--tmpfs" && base[i + 1] === "/tmp") || (flag === "--bind" && base[i + 2] === "/tmp"));
  if (mount < 0) throw Error("the proof sandbox has no private /tmp mount");
  let at = mount + (base[mount] === "--tmpfs" ? 2 : 3);
  while (base[at] === "--dir") at += 2;
  return at;
}

export function preopenGateSandboxArgv(input: GateContainInput, parentEnv: NodeJS.ProcessEnv = process.env): string[] {
  const base = proofSandboxArgv({ cwd: input.cwd, home: input.home, env: parentEnv });
  const harness = realpathSync(input.harnessRoot);
  const extra = [harness, ...proofLinkedModuleRoots(harness)].flatMap((path) => ["--ro-bind", path, path]);
  const slotsEnv = input.env[TEST_SLOT_DIR_ENV];
  const slots = typeof slotsEnv === "string" && existsSync(slotsEnv) && statSync(slotsEnv).isDirectory() ? realpathSync(slotsEnv) : undefined;
  if (slots !== undefined) extra.push("--bind", slots, slots);
  const masks: string[] = [];
  const dotGit = join(harness, ".git");
  if (existsSync(dotGit)) masks.push(...(lstatSync(dotGit).isDirectory() ? ["--tmpfs", dotGit] : ["--ro-bind", "/dev/null", dotGit]));
  const key = parentEnv.GH_APP_PRIVATE_KEY_PATH;
  const realKey = key && existsSync(key) ? realpathSync(key) : undefined;
  if (realKey !== undefined && [harness, ...(slots === undefined ? [] : [slots])].some((root) => within(realKey, root))) masks.push("--ro-bind", "/dev/null", realKey);
  const at = preopenSandboxBindStart(base);
  const chdir = base.lastIndexOf("--chdir");
  const proofBinds: string[] = [];
  for (let i = at; i < chdir; i += 3) {
    const [flag, from, to] = base.slice(i, i + 3) as [string, string, string];
    if (!(flag === "--ro-bind" && from === to && within(to, harness))) proofBinds.push(flag, from, to);
  }
  return [...base.slice(0, at), ...extra, ...proofBinds, ...masks, ...base.slice(chdir)];
}

/** A spawn failure's first useful line, bounded for a ledger row. */
function sandboxFailureText(error: unknown, binary: string): string {
  const err = error as NodeJS.ErrnoException & { stderr?: unknown };
  if (err.code === "ENOENT") return `${binary} is not installed`;
  const line = String(err.stderr ?? "").split("\n").find((l) => l.trim() !== "") ?? String(err.message ?? error);
  return line.trim().slice(0, 160);
}

/**
 * The real sandbox: refuse off Linux and for a worktree overlapping the harness checkout, build the argv, and
 * start it once around `node -e ""` (as the review proof children do), so a sandbox that cannot start is named
 * here and never read as the gate's own exit status. Async: the daemon's loop never waits on it.
 */
export async function defaultGateContainment(
  input: GateContainInput,
  { binary = PROOF_SANDBOX_BINARY, platform = process.platform, parentEnv = process.env }: { binary?: string; platform?: NodeJS.Platform; parentEnv?: NodeJS.ProcessEnv } = {},
): Promise<GateContainment> {
  if (platform !== "linux") return { mode: "unavailable", reason: `${binary} is Linux-only; this ${platform} host cannot contain the gate` };
  let argv: string[];
  try {
    const cwd = realpathSync(input.cwd);
    const harness = realpathSync(input.harnessRoot);
    if (within(cwd, harness) || within(harness, cwd)) return { mode: "unavailable", reason: "the worktree and the harness checkout overlap" };
    argv = preopenGateSandboxArgv(input, parentEnv);
  } catch (error) {
    return { mode: "unavailable", reason: `the sandbox argv could not be built: ${String((error as Error)?.message ?? error).slice(0, 160)}` };
  }
  return execFileLoopBounded(binary, [...argv, process.execPath, "-e", ""], { cwd: input.cwd, env: input.env, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" }).then(
    (): GateContainment => ({ mode: "sandboxed", file: binary, argv }),
    (error: unknown): GateContainment => ({ mode: "unavailable", reason: `${binary} cannot start here (${sandboxFailureText(error, binary)})` }),
  );
}

export interface RunGateDeadline {
  /** The backstop; default {@link PREOPEN_GATE_BACKSTOP_MS}. */
  backstopMs?: number;
  /** coreutils `timeout`, or `null` for none; default {@link gateTimeoutBin}. */
  timeoutBin?: string | null;
  /** Where the absolute deadline is read from; default the system clock. */
  clock?: Clock;
}

export interface RunGateContainment {
  /** Default {@link defaultGateContainment}. */
  contain?: GateContain;
  /** The environment the allowlist is cut from; default `process.env`. */
  parentEnv?: NodeJS.ProcessEnv;
  /** The harness checkout the gate's code comes from; default this module's own. */
  harnessRoot?: string;
  readFile?: (path: string) => string;
}

/** The summary file the harness asks the gate child to write, inside the harness-made HOME. */
export const GATE_SUMMARY_NAME = "preflight-summary.json";

/**
 * `harnessRmd` given means the caller chose the launcher (tests): it is run as given and no bundle is considered.
 *
 * W1-T9556: the gate runs under scripts/run-with-deadline.mjs, so its deadline is held by a process whose loop is
 * idle — and by coreutils `timeout` inside it where present — rather than by this process's loop, which a sync
 * spawn or ledger read can freeze for minutes. execFile's own timeout stays as a third, later line.
 *
 * W1-T9619: the runner starts the sandbox, which starts the harness's gate entry; every process gets the
 * allowlisted environment and a throwaway HOME, removed when the gate settles.
 */
export function defaultRunGate(
  cwd: string, harnessRmd?: string, log?: GateLog, deadline: RunGateDeadline = {}, containment: RunGateContainment = {},
): Promise<GateRun> {
  const backstopMs = deadline.backstopMs ?? PREOPEN_GATE_BACKSTOP_MS;
  const timeoutBin = deadline.timeoutBin === undefined ? gateTimeoutBin() : deadline.timeoutBin;
  const startedAt = (deadline.clock ?? systemClock).now();
  const deadlineAt = startedAt + backstopMs;
  const harnessRoot = containment.harnessRoot ?? HARNESS_ROOT;
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}preopen-gate-home-`));
  const cleanup = () => rmSync(home, { recursive: true, force: true });
  const run = (sandbox: GateContainment): Promise<GateRun> => {
    if (sandbox.mode !== "sandboxed") return Promise.resolve({ exitCode: null, error: `the gate could not be contained: ${sandbox.reason}`, containment: "unmeasured" });
    const summaryFile = join(home, GATE_SUMMARY_NAME);
    // Only our maintained launcher promises the new option. A caller-selected legacy launcher
    // keeps its existing argv contract and reports missing measurements explicitly.
    const extraArgs = ["--summary-file", summaryFile, ...(harnessRmd === undefined ? ["--sandbox-metrics"] : [])];
    const { file, args } = harnessRmd === undefined
      ? preopenGateLaunch(cwd, log, join(harnessRoot, "bin", "rmd"), harnessRoot, {
        deadline_enforced_by: armedEnforcers(timeoutBin), launcher: "harness", containment: "sandboxed", env_allowlist: PREOPEN_GATE_ENV_ALLOWLIST_NAME,
      }, extraArgs)
      : preopenGateCommand(cwd, harnessRmd, extraArgs);
    return execFileLoopBounded(process.execPath, deadlineRunnerArgs(sandbox.file, [...sandbox.argv, file, ...args], deadlineAt, timeoutBin),
      { cwd, env, encoding: "utf8", timeout: backstopMs + 2 * GATE_KILL_GRACE_MS, maxBuffer: 64 * 1024 * 1024 }).then(
      () => classifyGateExit(null, ""),
      (error: Error & { code?: unknown; killed?: boolean; stderr?: unknown }) => classifyGateExit(error, String(error.stderr ?? "")),
    ).then((exited) => {
      const read = readGateSummary(summaryFile, startedAt, containment.readFile);
      const summary = exited.exitCode === 1 && exited.error === undefined ? read : undefined;
      const sandboxMetrics = read.sandboxMetrics ?? { sandbox_unmeasured: "unreadable" in read ? read.unreadable : "the child wrote no sandbox measurement" };
      return { ...exited, containment: "sandboxed" as const, sandboxMetrics, ...(summary ? { summary } : {}) };
    });
  };
  let env: NodeJS.ProcessEnv = {};
  let settled: Promise<GateRun>;
  try {
    env = preopenGateEnv(home, containment.parentEnv ?? process.env);
    const contain = containment.contain ?? ((input: GateContainInput) => defaultGateContainment(input, { parentEnv: containment.parentEnv }));
    const sandbox = contain({ cwd, home, harnessRoot, env });
    // A sandbox already in hand starts the child in this call, before the caller's loop can stall (W1-T9556).
    settled = sandbox instanceof Promise ? sandbox.then(run) : run(sandbox);
  } catch (error) {
    // A containment or launch that threw: no child started, so the gate is unmeasured with why, never a pass.
    cleanup();
    return Promise.resolve({ exitCode: null, error: `the gate could not start: ${String((error as Error)?.message ?? error).slice(0, 160)}` });
  }
  return settled.finally(cleanup);
}

/** The failing step names a summary at `summaryFile` records, if written at or after `startedAt`, or why it can't be read. */
export function readGateSummary(
  summaryFile: string,
  startedAt: number,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): GateSummary {
  let parsed: { ok?: unknown; finishedAt?: unknown; steps?: unknown; sandboxMetrics?: unknown };
  try {
    parsed = JSON.parse(readFile(summaryFile)) as typeof parsed;
  } catch (e) {
    return { unreadable: `no readable preflight summary (${(e as Error).message})` };
  }
  if (!parsed || typeof parsed !== "object") return { unreadable: "the preflight summary is not an object" };
  const finished = typeof parsed.finishedAt === "string" ? Date.parse(parsed.finishedAt) : NaN;
  if (!Number.isFinite(finished) || finished < startedAt) return { unreadable: "the preflight summary predates this gate run" };
  const steps = Array.isArray(parsed.steps) ? (parsed.steps as Array<{ name?: unknown; ok?: unknown }>) : [];
  return {
    failedSteps: steps.filter((s) => s && s.ok === false).map((s) => (typeof s.name === "string" && s.name ? s.name : "(unnamed step)")),
    ...(parsed.sandboxMetrics === undefined ? {} : { sandboxMetrics: parseGateSandboxMeasurement(parsed.sandboxMetrics) }),
  };
}

/** The step a failed gate is handed back under when its summary named none. */
export const GATE_FAILED_NO_STEP_NAMED = "(the fast gate failed and its summary named no step)";

/**
 * Run the fast gate in a build's worktree and classify the result. Pass and fail are the child's exit status
 * (0 and 1) as the harness observed it; any other status, a deadline kill or a missing sandbox is unmeasured.
 */
export async function runPreopenGate(worktreePath: string, deps: PreopenGateOptions = {}): Promise<PreopenGateResult> {
  const clock = deps.clock ?? systemClock;
  const now = () => clock.now();
  const startedAt = now();
  const run = await (deps.runGate ?? ((cwd) => defaultRunGate(cwd, undefined, deps.log, {}, { contain: deps.contain, readFile: deps.readFile })))(worktreePath);
  const fast = classifyGateRun(run, now() - startedAt);
  if (fast.kind === "unmeasured") return fast;
  // W1-T10267: a procfs write in a changed test blocks until timeout-minutes in CI; refuse it here, before a PR opens.
  const procfs = (deps.scanProcfsWrites ?? changedProcfsWriteOffences)(worktreePath);
  if (procfs.length > 0) {
    const steps = [...(fast.kind === "fail" ? fast.failedSteps : []), `procfs-write: a test aims a write-shaped call at /proc (it blocks, use a FILE where a directory must be): ${procfs.join("; ")}`];
    return { kind: "fail", failedSteps: steps, durationMs: fast.durationMs, ...(fast.containment ? { containment: fast.containment } : {}), ...(fast.sandboxMetrics ? { sandboxMetrics: fast.sandboxMetrics } : {}) };
  }
  // W1-T9602: the same harness push gate the push leaf runs, asked now on the clean committed tree. A pass is
  // recorded and the push of that identical tree reuses it; a refusal joins the steps handed back, as push-gate.
  const pushStarted = now();
  const asked = await (deps.runPushGate ?? ((cwd) => runPushGate(cwd)))(worktreePath);
  const pushGate: PreopenPushGate = {
    outcome: asked.kind,
    durationMs: now() - pushStarted,
    ...(asked.kind === "pass" ? { reused: asked.reused } : asked.kind === "skipped" ? { reason: asked.reason } : {}),
    ...(asked.key ? { key: asked.key } : {}),
  };
  if (asked.kind !== "refused") return { ...fast, pushGate };
  const failedSteps = [...(fast.kind === "fail" ? fast.failedSteps : []), `${PUSH_GATE_STEP_NAME}: ${asked.detail}`];
  return { kind: "fail", failedSteps, durationMs: fast.durationMs, ...(fast.containment ? { containment: fast.containment } : {}), ...(fast.sandboxMetrics ? { sandboxMetrics: fast.sandboxMetrics } : {}), pushGate };
}

/** The failing step a push-gate refusal is handed back under, with the hook's own words after it. */
export const PUSH_GATE_STEP_NAME = "push-gate";

/** Pass and fail are the child's exit status (0 and 1) as the harness observed it; anything else is unmeasured. */
function classifyGateRun(run: GateRun, durationMs: number): PreopenGateResult {
  const containment = { ...(run.containment ? { containment: run.containment } : {}), ...(run.sandboxMetrics ? { sandboxMetrics: run.sandboxMetrics } : {}) };
  if (run.error !== undefined) {
    return { kind: "unmeasured", reason: run.error, durationMs, ...(run.deadlineEnforcedBy ? { deadlineEnforcedBy: run.deadlineEnforcedBy } : {}), ...containment };
  }
  if (run.exitCode === 0) return { kind: "pass", durationMs, ...containment };
  if (run.exitCode !== 1) return { kind: "unmeasured", reason: `the fast gate exited ${run.exitCode}`, durationMs, ...containment };
  const read = run.summary ?? { unreadable: "the gate runner returned no summary" };
  if ("unreadable" in read) return { kind: "unmeasured", reason: read.unreadable, durationMs, ...containment };
  return { kind: "fail", failedSteps: read.failedSteps.length > 0 ? read.failedSteps : [GATE_FAILED_NO_STEP_NAMED], durationMs, ...containment };
}

/**
 * W1-T9619: what `implement.preopen_gate` records about how the gate ran: the launcher, the containment and the
 * allowlist's name. W1-T9602: and the early push gate's outcome with the tree, head, base and recipe it keyed, so
 * the reuse rate is read from the ledger.
 */
export function preopenGateLedgerFields(result: PreopenGateResult): Record<string, unknown> {
  const containment = result.containment === undefined ? {} : { launcher: "harness", containment: result.containment, env_allowlist: PREOPEN_GATE_ENV_ALLOWLIST_NAME };
  const push = "pushGate" in result && result.pushGate ? result.pushGate : undefined;
  return {
    ...containment,
    ...(result.sandboxMetrics ?? (result.containment === "sandboxed" ? { sandbox_unmeasured: "the child wrote no sandbox measurement" } : {})),
    ...(push ? {
      push_gate: push.outcome,
      push_gate_ms: push.durationMs,
      ...(push.reused === undefined ? {} : { push_gate_reused: push.reused }),
      ...(push.reason === undefined ? {} : { push_gate_reason: push.reason }),
      ...(push.key ?? {}),
    } : {}),
  };
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
