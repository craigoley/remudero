/**
 * Crash boundary for daemon-fired retros. The foreground `rmd retro` command remains in-process;
 * only the daemon hook comes through this adapter.
 */
import { fileURLToPath } from "node:url";
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

type FiredRetroDecision = Extract<RetroTriggerDecision, { fire: true }>;
type RetroLog = (step: string, extra?: Record<string, unknown>) => void;

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
        args: [`--max-old-space-size=${AUTOMATED_RETRO_HEAP_LIMIT_MB}`, "--import", "tsx", entrypoint, "retro"],
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
    });
    const terminal = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("exit", (code, childSignal) => resolve({ code, signal: childSignal }));
      child.once("error", reject);
    });
    exitCode = terminal.code;
    signal = terminal.signal;
    if (spawnError) throw spawnError;
    if (exitCode !== 0 || signal !== null) {
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
    outcome: "success",
    failure_class: null,
  });
}
