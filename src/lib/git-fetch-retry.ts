/** A leaf module so worker.ts and self-sync.ts can share the fetch retry without an import cycle. */
import type { ChildProcess } from "node:child_process";

export type GitRunner = (args: string[]) => string;
/** The same runner, off the event loop: a network `git fetch` on the daemon loop stalled it 49 s (E36).
 *  `signal` aborts at the fetch's bound; the real runner kills its child on it (W1-T5282). */
export type AsyncGitRunner = (args: string[], signal?: AbortSignal) => Promise<string>;

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

/** One awaited git call ended at `timeoutMs` (W1-T5282): the signal aborts, and the call rejects whether or
 *  not the runner honours it, so a hung fetch reads as a failed one and never holds its awaiter forever. */
export function boundGitCall(git: AsyncGitRunner, args: string[], timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`git ${args.join(" ")} exceeded its ${timeoutMs}ms bound and was killed`));
    }, timeoutMs);
    git(args, controller.signal).then(
      (out) => {
        clearTimeout(timer);
        resolve(out);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
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
export function fetchOriginRetryingRefLock(git: GitRunner, sleep: (ms: number) => void = blockingSleep, attempts = 3): void {
  for (let attempt = 1; ; attempt++) {
    try {
      git(["fetch", "--quiet", "origin"]);
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
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await boundGitCall(git, ["fetch", "--quiet", "origin"], timeoutMs);
      return;
    } catch (error) {
      if (attempt >= attempts || !isRefLockFailure(error)) throw error;
      await sleep(1_000 * attempt);
    }
  }
}
