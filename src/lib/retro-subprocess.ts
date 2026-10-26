/**
 * Crash boundary for daemon-fired retros. The foreground `rmd retro` command remains in-process;
 * only the daemon hook comes through this adapter.
 */
import { fileURLToPath } from "node:url";
import { childHeapPolicyArgs } from "./daemon-memory-policy.js";
import {
  spawnDetachedGroup,
  teardownProcessGroup,
  type ContainedProcess,
  type ContainedSpawnOptions,
} from "./worker-containment.js";
import type { RetroTriggerDecision } from "./retro.js";

export const AUTOMATED_RETRO_DECISION_ENV = "RMD_AUTOMATED_RETRO_DECISION";
/** PRIMARY CONTROL: bounds the child V8 heap before optional retro work can consume the host. */
export const AUTOMATED_RETRO_HEAP_LIMIT_MB = 1792;
export const AUTOMATED_RETRO_OUTPUT_TAIL_BYTES = 16 * 1024;

export const RETRO_HANDOFF_EXIT_CODES = { 3: "ci_not_concluded", 4: "review_withheld" } as const;
type RetroHandoffReason = (typeof RETRO_HANDOFF_EXIT_CODES)[keyof typeof RETRO_HANDOFF_EXIT_CODES];

export function retroExitAfterPrOpened(ci: "green" | "red" | "timeout" | "freshness_handoff", reviewCode?: number): number {
  if (ci === "red") return 1;
  if (ci !== "green") return 3;
  if (reviewCode === 2) return 4;
  return reviewCode ?? 0;
}

function handoffReason(exitCode: number | null): RetroHandoffReason | undefined {
  return exitCode === 3 || exitCode === 4 ? RETRO_HANDOFF_EXIT_CODES[exitCode] : undefined;
}

type FiredRetroDecision = Extract<RetroTriggerDecision, { fire: true }>;
type RetroLog = (step: string, extra?: Record<string, unknown>) => void;

type RetroGatherPhase = "followup-ledger" | "plan-inputs" | "gather" | "net-state" | "plan-projection" | "report";

/** Observe synchronous gather work without retaining its inputs or changing its result.
 * A returned stage can contain an existing degraded result; it is NOT a publication/health verdict.
 * An entered stage with no return only locates the last observation, not the cause of a process death.
 * Manual/dry-run retro keeps its existing no-observation path. */
export function automatedRetroGatherObserver(automated: boolean, ctx: {
  log: RetroLog;
  now?: () => number;
  memoryUsage?: () => NodeJS.MemoryUsage;
  warn?: (message: string) => void;
}): <T>(phase: RetroGatherPhase, read: () => T) => T {
  return (phase, read) => {
    if (!automated) return read();
    let started: number | undefined;
    const observe = (state: "entered" | "returned" | "threw"): void => {
      try {
        const at = (ctx.now ?? Date.now)();
        if (started === undefined) started = at;
        const memory = (ctx.memoryUsage ?? (() => process.memoryUsage()))();
        ctx.log("retro.gather.phase", { phase, phase_state: state, duration_ms: Math.max(0, at - started),
          rss_bytes: memory.rss, heap_used_bytes: memory.heapUsed, heap_total_bytes: memory.heapTotal,
          external_bytes: memory.external, array_buffers_bytes: memory.arrayBuffers });
      } catch {
        // Diagnostic failure must not mask a read's original error or cause the read to run twice.
        (ctx.warn ?? ((message: string) => console.error(message)))("### [retro] gather phase observation unavailable");
      }
    };
    observe("entered");
    let returned = false;
    try {
      const value = read();
      returned = true;
      return value;
    } finally {
      observe(returned ? "returned" : "threw");
    }
  };
}

export class AutomatedRetroSubprocessError extends Error {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdoutTail: string;
  readonly stderrTail: string;

  constructor(input: {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stdoutTail: string;
    stderrTail: string;
    cause?: unknown;
  }) {
    const provenance = input.signal ? `signal ${input.signal}` : `exit ${String(input.exitCode)}`;
    super(`automated retro subprocess failed (${provenance})`, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "AutomatedRetroSubprocessError";
    this.exitCode = input.exitCode;
    this.signal = input.signal;
    this.stdoutTail = input.stdoutTail;
    this.stderrTail = input.stderrTail;
  }
}

function encodedDecision(decision: FiredRetroDecision): string {
  return JSON.stringify({
    ...decision,
    daysSinceMarker: decision.daysSinceMarker === Infinity ? "Infinity" : decision.daysSinceMarker,
  });
}

/** Decode only the internal, daemon-minted envelope. Invalid envelopes fail closed. */
export function decodeAutomatedRetroDecision(value: string | undefined): FiredRetroDecision {
  if (!value) throw new Error(`${AUTOMATED_RETRO_DECISION_ENV} is absent`);
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch (cause) {
    throw new Error(`${AUTOMATED_RETRO_DECISION_ENV} is not valid JSON`, { cause });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${AUTOMATED_RETRO_DECISION_ENV} is not an object`);
  }
  const row = raw as Record<string, unknown>;
  const daysSinceMarker = row.daysSinceMarker === "Infinity" ? Infinity : row.daysSinceMarker;
  const followupsPending = row.followupsPending;
  if (
    row.fire !== true ||
    (row.reason !== "merges" && row.reason !== "days" && row.reason !== "followups") ||
    !Number.isFinite(row.mergesSinceMarker) ||
    Number(row.mergesSinceMarker) < 0 ||
    !(daysSinceMarker === Infinity || (Number.isFinite(daysSinceMarker) && Number(daysSinceMarker) >= 0)) ||
    !(followupsPending === undefined || (Number.isFinite(followupsPending) && Number(followupsPending) >= 0))
  ) {
    throw new Error(`${AUTOMATED_RETRO_DECISION_ENV} has an invalid decision shape`);
  }
  return {
    fire: true,
    reason: row.reason,
    mergesSinceMarker: Number(row.mergesSinceMarker),
    daysSinceMarker: Number(daysSinceMarker),
    ...(followupsPending === undefined ? {} : { followupsPending: Number(followupsPending) }),
  };
}

function secretValues(env: Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter(([name, value]) => value && /(?:auth|credential|key|password|secret|token)/i.test(name))
    .map(([, value]) => value!)
    .filter((value) => value.length >= 4)
    .sort((a, b) => b.length - a.length);
}

function redact(text: string, secrets: readonly string[]): string {
  let projected = text.replace(
    /\b([A-Z][A-Z0-9_]*(?:AUTH|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)[A-Z0-9_]*)\s*=\s*([^\s]+)/gi,
    "$1=[REDACTED]",
  );
  for (const secret of secrets) projected = projected.split(secret).join("[REDACTED]");
  return projected;
}

function boundedTail(text: string, secrets: readonly string[]): string {
  const bytes = Buffer.from(redact(text, secrets), "utf8");
  return bytes.subarray(Math.max(0, bytes.length - AUTOMATED_RETRO_OUTPUT_TAIL_BYTES)).toString("utf8");
}

export async function runAutomatedRetroSubprocess(
  decision: FiredRetroDecision,
  deps: {
    spawn?: (
      options: ContainedSpawnOptions,
      onStderr?: (chunk: string) => void,
      onSpawnError?: (error: NodeJS.ErrnoException) => void,
    ) => ContainedProcess;
    teardown?: (pid: number) => unknown;
    log?: RetroLog;
    now?: () => number;
    env?: Record<string, string | undefined>;
    entrypoint?: string;
  } = {},
): Promise<void> {
  const spawn = deps.spawn ?? spawnDetachedGroup;
  const teardown = deps.teardown ?? ((pid: number) => teardownProcessGroup(pid));
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  const inheritedEnv = deps.env ?? process.env;
  const secrets = secretValues(inheritedEnv);
  const env = {
    ...inheritedEnv,
    [AUTOMATED_RETRO_DECISION_ENV]: encodedDecision(decision),
    RMD_SELF_SYNC_DONE: "1",
  };
  const entrypoint = deps.entrypoint ?? fileURLToPath(new URL("../run-task.ts", import.meta.url));
  const startedAt = now();
  const nodeArgs = childHeapPolicyArgs();
  let stdout = "";
  let stderr = "";
  let spawnError: Error | undefined;
  let contained: ContainedProcess | undefined;
  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  let failure: AutomatedRetroSubprocessError | undefined;
  let failureClass: "spawn_error" | "signal" | "nonzero_exit" | "teardown_error" = "spawn_error";

  try {
    contained = spawn(
      {
        command: process.execPath,
        args: [`--max-old-space-size=${AUTOMATED_RETRO_HEAP_LIMIT_MB}`, ...nodeArgs, "--import", "tsx", entrypoint, "retro"],
        env,
      },
      (chunk) => {
        stderr = boundedTail(`${stderr}${chunk}`, secrets);
      },
      (error) => {
        spawnError = error;
      },
    );
    const child = contained.process;
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout = boundedTail(`${stdout}${String(chunk)}`, secrets);
    });
    log("daemon.retro_subprocess.start", {
      child_pid: contained.pid,
      heap_limit_mb: AUTOMATED_RETRO_HEAP_LIMIT_MB,
      node_args: nodeArgs,
    });
    const terminal = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("exit", (code, childSignal) => resolve({ code, signal: childSignal }));
      child.once("error", reject);
    });
    exitCode = terminal.code;
    signal = terminal.signal;
    if (spawnError) throw spawnError;
    if ((exitCode !== 0 && handoffReason(exitCode) === undefined) || signal !== null) {
      throw new AutomatedRetroSubprocessError({ exitCode, signal, stdoutTail: stdout, stderrTail: stderr });
    }
  } catch (cause) {
    // Preserve every launch/runtime distinction in the named error and terminal row below.
    failure = cause instanceof AutomatedRetroSubprocessError
      ? cause
      : new AutomatedRetroSubprocessError({ exitCode, signal, stdoutTail: stdout, stderrTail: stderr, cause });
    failureClass = signal ? "signal" : exitCode === null ? "spawn_error" : "nonzero_exit";
  } finally {
    if (contained) {
      try {
        teardown(contained.pid);
      } catch (cause) {
        // A teardown refusal becomes this fire's named failure; it is never erased as success.
        if (!failure) {
          failure = new AutomatedRetroSubprocessError({ exitCode, signal, stdoutTail: stdout, stderrTail: stderr, cause });
          failureClass = "teardown_error";
        }
      }
    }
  }

  const durationMs = now() - startedAt;
  if (failure) {
    log("daemon.retro_subprocess.terminal", {
      ...(contained ? { child_pid: contained.pid } : {}),
      heap_limit_mb: AUTOMATED_RETRO_HEAP_LIMIT_MB,
      duration_ms: durationMs,
      exit_code: failure.exitCode,
      signal: failure.signal,
      outcome: "failure",
      failure_class: failureClass,
      stdout_tail: boundedTail(failure.stdoutTail, secrets),
      stderr_tail: boundedTail(failure.stderrTail, secrets),
    });
    throw failure;
  }
  log("daemon.retro_subprocess.terminal", {
    child_pid: contained!.pid,
    heap_limit_mb: AUTOMATED_RETRO_HEAP_LIMIT_MB,
    duration_ms: durationMs,
    exit_code: exitCode,
    signal,
    outcome: handoffReason(exitCode) === undefined ? "success" : "handed_off",
    failure_class: null,
    ...(handoffReason(exitCode) === undefined ? {} : { handoff_reason: handoffReason(exitCode) }),
  });
}
