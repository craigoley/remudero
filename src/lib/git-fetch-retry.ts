/** A leaf module so worker.ts and self-sync.ts can share the fetch retry without an import cycle. */
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type GitRunner = (args: string[]) => string;
/** The same runner, off the event loop: a network `git fetch` on the daemon loop stalled it 49 s (E36).
 *  `signal` aborts at the fetch's bound; the real runner kills its child on it (W1-T5282). */
export type AsyncGitRunner = (args: string[], signal?: AbortSignal, env?: NodeJS.ProcessEnv) => Promise<string>;

/** W1-T4229 BACKSTOP: a hung fetch must not hold the checkout read open past the next re-check.
 *  Moved here from serve.ts so the daemon's awaited freshness reads share the number (W1-T5282). */
export const GATEWAY_FETCH_TIMEOUT_MS = 60_000;

/** W1-T5282 BACKSTOP: how long a fetch killed at its bound may ignore SIGTERM before SIGKILL. */
export const GIT_FETCH_KILL_GRACE_MS = 5_000;

/** SIGKILL for a child still running `graceMs` after its SIGTERM; one that already exited is left alone. */
export function killAfterGrace(child: Pick<ChildProcess, "exitCode" | "signalCode" | "kill">, graceMs = GIT_FETCH_KILL_GRACE_MS): void {
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, graceMs).unref();
}

/** W1-T5964: a bound timer this late was held by a blocked event loop, not by git. */
export const LATE_TIMER_SLACK_MS = 1_000;
/** W1-T5964: how long a late bound waits for a fetch whose exit may already be queued behind it. */
export const LATE_TIMER_GRACE_MS = 2_000;

/** {@link boundGitCall}'s rejection when the call outran its bound — typed so a caller can name the timeout
 *  apart from git's own failure. The message and `name` ("Error") are unchanged, so every rendering of it is too. */
export class GitCallBoundExceededError extends Error {}

/** One awaited git call ended at `timeoutMs` (W1-T5282): the signal aborts, and the call rejects whether or
 *  not the runner honours it, so a hung fetch reads as a failed one and never holds its awaiter forever.
 *  W1-T5964: a timer that fires late first waits `lateGraceMs`, since timers run before the poll phase
 *  that would deliver a finished child's exit; #9460's review was withheld for a fetch that had finished. */
export async function boundGitCall(git: AsyncGitRunner, args: string[], timeoutMs: number, lateGraceMs = LATE_TIMER_GRACE_MS): Promise<string> {
  const controller = new AbortController();
  const traceDir = mkdtempSync(join(tmpdir(), "rmd-fetch-trace-"));
  const tracePath = join(traceDir, "events.json");
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      const fail = (lateMs: number): void => {
        const trace = readTrace(tracePath);
        reject(new GitCallBoundExceededError(`git ${args.join(" ")} exceeded its ${timeoutMs}ms bound and was killed; ` +
          `last trace2 region: ${trace.region}; ` +
          `elapsed ${Math.round(performance.now() - started)}ms` +
          (trace.running ? `; still running: ${trace.running}` : "") +
          (lateMs > LATE_TIMER_SLACK_MS ? `; its timer fired ${Math.round(lateMs)}ms late (event loop blocked)` : "")));
        controller.abort();
      };
      timer = setTimeout(() => {
        const lateMs = performance.now() - started - timeoutMs;
        if (lateMs > LATE_TIMER_SLACK_MS) timer = setTimeout(() => fail(lateMs), lateGraceMs);
        else fail(lateMs);
      }, timeoutMs);
      Promise.resolve().then(() => git(args, controller.signal, { ...process.env, GIT_TRACE2_EVENT: tracePath })).then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
    rmSync(traceDir, { recursive: true, force: true });
  }
}

/** The last region a fetch entered, and (W1-T5964) any child it started and never reaped: a fetch past its
 *  final region is waiting on one, e.g. the `git maintenance run --auto` it starts at exit. */
function readTrace(path: string): { region: string; running?: string } {
  let trace: string;
  try {
    trace = readFileSync(path, "utf8");
  } catch (error) {
    const reason = String(error);
    return { region: `unavailable (could not read trace: ${reason})` };
  }
  let last: string | undefined;
  let unavailable = "no region_enter event recorded";
  const children = new Map<string, string>();
  for (const line of trace.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { event?: string; category?: string; label?: string; sid?: string; child_id?: number; argv?: unknown } | null;
      if (event?.event === "region_enter" && typeof event.label === "string") {
        last = event.category ? `${event.category}/${event.label}` : event.label;
      }
      const child = `${event?.sid}#${event?.child_id}`;
      if (event?.event === "child_start") {
        children.set(child, Array.isArray(event.argv) ? event.argv.join(" ") : `(child ${event.child_id}, argv unrecorded)`);
      } else if (event?.event === "child_exit") children.delete(child);
    } catch (error) {
      const reason = String(error);
      unavailable = `could not parse trace event: ${reason}`;
    }
  }
  const running = [...children.values()].join(", ");
  return { region: last ?? `unavailable (${unavailable})`, ...(running ? { running } : {}) };
}

function fetchArgs(scope: "all" | "main"): string[] {
  return scope === "main"
    ? ["fetch", "--quiet", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]
    : ["fetch", "--quiet", "origin"];
}

const REF_LOCK_FAILURE = /cannot lock ref|unable to update local ref/i;

function isRefLockFailure(error: unknown): boolean {
  const e = error as { stderr?: unknown; message?: unknown } | null;
  return REF_LOCK_FAILURE.test(`${String(e?.stderr ?? "")}\n${String(e?.message ?? error)}`);
}

function blockingSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function timerSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `git fetch origin`, retried briefly on a transient ref lock (#8017 lost ~1h to one); anything else throws. */
export function fetchOriginRetryingRefLock(git: GitRunner, sleep: (ms: number) => void = blockingSleep, attempts = 3, scope: "all" | "main" = "all"): void {
  for (let attempt = 1; ; attempt++) {
    try {
      git(fetchArgs(scope));
      return;
    } catch (error) {
      if (attempt >= attempts || !isRefLockFailure(error)) throw error;
      sleep(1_000 * attempt);
    }
  }
}

/** {@link fetchOriginRetryingRefLock} with an awaited fetch and a timer backoff: same retries, same throws.
 *  Each attempt is bounded by `timeoutMs`; one past it throws like any other failed fetch (W1-T5282). */
export async function fetchOriginRetryingRefLockAsync(
  git: AsyncGitRunner,
  sleep: (ms: number) => Promise<void> = timerSleep,
  attempts = 3,
  timeoutMs = GATEWAY_FETCH_TIMEOUT_MS,
  scope: "all" | "main" = "all",
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await boundGitCall(git, fetchArgs(scope), timeoutMs);
      return;
    } catch (error) {
      if (attempt >= attempts || !isRefLockFailure(error)) throw error;
      await sleep(1_000 * attempt);
    }
  }
}
