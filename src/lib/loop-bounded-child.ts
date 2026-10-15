/**
 * W1-T9651 — A DAEMON-LOOP CHILD PROCESS IS BOUNDED BY LOOP-AVAILABLE TIME, NEVER A WALL-CLOCK TIMER.
 *
 * When a held loop resumes, Node runs due timers before it processes I/O, so a child that already exited still
 * has its exit and its last stdout waiting in the pipe. Two wall-clock bounds then go wrong:
 *  - execFile's own `timeout` calls execFile's internal kill(), which DESTROYS the unread stdout; the pending exit
 *    is code 0 with no signal, so the call RESOLVES with whatever it had read, often nothing (#11985: an empty
 *    `git config --list`, and three pushes ran with no credential helper).
 *  - a hand-rolled `setTimeout(() => child.kill())` marks a finished child as timed out.
 *
 * Both helpers here arm {@link loopAvailableDeadline} instead: a firing late by a twentieth of its budget re-arms
 * for the held time, so only a deadline that fires on a free loop expires. The kill is `child.kill(signal)`, never
 * execFile's internal kill(), so a pending exit keeps its stdout. A child killed at its budget is a FAILURE: the
 * call rejects with {@link LoopBoundedChildTimeout} (callback forms read `timedOut`), even when the child traps the
 * signal and exits 0.
 */
import { execFile, type ChildProcess, type ExecFileOptionsWithStringEncoding, type PromiseWithChild } from "node:child_process";
import { promisify } from "node:util";
import { loopAvailableDeadline, systemClock, type Clock } from "./clock.js";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";

const execFilePromise = promisify(execFile);

/** A child stopped at its loop-available budget. Shaped like execFile's own kill error (`Command failed: <cmd>`,
 *  `killed`, `signal`, `code: null`, `stdout`, `stderr`), so a caller that classifies those keeps working; but it is
 *  always a rejection, never a success. */
export class LoopBoundedChildTimeout extends RmdError {
  readonly killed = true;
  /** Never an exit status: a caller reading a numeric `code` as one must not see a stopped child as exit 0. */
  readonly code = null;
  readonly budgetMs: number;
  /** The signal the child died by, or the one it was sent when it trapped it. */
  readonly signal: NodeJS.Signals | null;
  /** The exit code the child reported after the signal (0 when it trapped it), or null when the signal ended it. */
  readonly childExitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(command: string, budgetMs: number, facts: ChildFacts = {}) {
    const stderr = typeof facts.stderr === "string" ? facts.stderr : "";
    super("child_process", GENERIC_EXIT_CODE, `Command failed: ${command}\nstopped${facts.signal ? ` by ${facts.signal}` : ""} at its ${budgetMs}ms loop-available budget${stderr ? `\n${stderr}` : ""}`);
    this.name = "LoopBoundedChildTimeout";
    this.budgetMs = budgetMs;
    this.signal = facts.signal ?? null;
    this.childExitCode = facts.exitCode ?? null;
    this.stdout = typeof facts.stdout === "string" ? facts.stdout : "";
    this.stderr = stderr;
  }
}

/** What a stopped child reported, for {@link LoopBoundedChildTimeout}. */
export interface ChildFacts {
  signal?: NodeJS.Signals | null;
  exitCode?: number | null;
  stdout?: unknown;
  stderr?: unknown;
}

export interface LoopBound {
  /** True once the budget expired on a free loop and the child was signalled. */
  readonly timedOut: boolean;
  /** Disarms the deadline and any escalation (the child's own exit does this too). */
  cancel(): void;
  /** The named rejection for this bound, carrying what the child reported. */
  timeoutError(command: string, facts?: ChildFacts): LoopBoundedChildTimeout;
}

export interface LoopBoundOptions {
  /** The first signal at the budget (default SIGTERM). */
  killSignal?: NodeJS.Signals | number;
  /** When set, a child still running this long after the first signal gets SIGKILL, on the same loop-available
   *  deadline (W1-T4446/W1-T5282's escalation, never a wall-clock timer). */
  escalateAfterMs?: number;
  /** Called once when the budget expires, before the kill (a caller's own timed-out bookkeeping). */
  onExpire?: () => void;
  /** Called when the escalation sends SIGKILL. */
  onEscalate?: () => void;
  clock?: Clock;
}

/**
 * Bounds a running child (a callback execFile or a spawn) by loop-available time. The bound disarms itself when
 * the child exits; a caller reads `timedOut` in its exit/close handler and reports a failure when it is set.
 */
export function boundChildByLoopTime(
  child: Pick<ChildProcess, "kill"> & Partial<Pick<ChildProcess, "once" | "exitCode" | "signalCode">>,
  budgetMs: number,
  opts: LoopBoundOptions = {},
): LoopBound {
  const clock = opts.clock ?? systemClock;
  const killSignal = opts.killSignal ?? "SIGTERM";
  let timedOut = false;
  let cancelEscalation: (() => void) | undefined;
  const cancelDeadline = loopAvailableDeadline(clock, budgetMs, () => {
    timedOut = true;
    opts.onExpire?.();
    child.kill(killSignal);
    const graceMs = opts.escalateAfterMs;
    if (graceMs !== undefined && graceMs > 0) {
      cancelEscalation = loopAvailableDeadline(clock, graceMs, () => {
        if ((child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null) return;
        opts.onEscalate?.();
        child.kill("SIGKILL");
      });
    }
  });
  const cancel = (): void => {
    cancelDeadline();
    cancelEscalation?.();
  };
  // A test seam's stand-in child may not be an emitter; its caller cancels from its own callback.
  child.once?.("exit", cancel);
  child.once?.("error", cancel);
  return {
    get timedOut() {
      return timedOut;
    },
    cancel,
    timeoutError: (command, facts = {}) =>
      new LoopBoundedChildTimeout(command, budgetMs, { signal: typeof killSignal === "string" ? killSignal : null, ...facts }),
  };
}

/** Facts off an execFile result or rejection, for the named rejection. */
function childFacts(value: unknown, exitCode: number | null): ChildFacts {
  const v = (value ?? {}) as { signal?: NodeJS.Signals | null; stdout?: unknown; stderr?: unknown };
  const facts = { exitCode, stdout: v.stdout, stderr: v.stderr };
  return v.signal ? { ...facts, signal: v.signal } : facts;
}

/** A promise execFile bounded by LOOP-AVAILABLE time (`timeout` is its budget; `killSignal` its first signal).
 *  A child killed at its budget rejects with {@link LoopBoundedChildTimeout}, even when it exits 0 after the signal.
 *  Without a positive `timeout` it is plain `promisify(execFile)`. */
export function execFileLoopBounded(
  file: string,
  args: readonly string[],
  opts: ExecFileOptionsWithStringEncoding & { escalateAfterMs?: number },
): PromiseWithChild<{ stdout: string; stderr: string }> {
  const { timeout, killSignal, escalateAfterMs, ...rest } = opts;
  const command = execFilePromise(file, [...args], rest);
  if (timeout === undefined || timeout <= 0) return command;
  const bound = boundChildByLoopTime(command.child, timeout, { killSignal, escalateAfterMs });
  const label = [file, ...args].join(" ");
  const settled = command.then(
    (result) => {
      bound.cancel();
      if (bound.timedOut) throw bound.timeoutError(label, childFacts(result, 0));
      return result;
    },
    (error: unknown) => {
      bound.cancel();
      throw bound.timedOut ? bound.timeoutError(label, childFacts(error, typeof (error as { code?: unknown })?.code === "number" ? (error as { code: number }).code : null)) : error;
    },
  ) as PromiseWithChild<{ stdout: string; stderr: string }>;
  settled.child = command.child;
  return settled;
}

/** True for a {@link LoopBoundedChildTimeout} (or anything shaped like one across a module copy). */
export function isLoopBoundedChildTimeout(error: unknown): error is LoopBoundedChildTimeout {
  return error instanceof LoopBoundedChildTimeout || (error as { name?: unknown } | null)?.name === "LoopBoundedChildTimeout";
}
