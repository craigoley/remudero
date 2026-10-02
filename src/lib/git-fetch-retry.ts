/** A leaf module so worker.ts and self-sync.ts can share the fetch retry without an import cycle. */
export type GitRunner = (args: string[]) => string;
/** The same runner, off the event loop: a network `git fetch` on the daemon loop stalled it 49 s (E36). */
export type AsyncGitRunner = (args: string[]) => Promise<string>;

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

/** {@link fetchOriginRetryingRefLock} with an awaited fetch and a timer backoff: same retries, same throws. */
export async function fetchOriginRetryingRefLockAsync(
  git: AsyncGitRunner,
  sleep: (ms: number) => Promise<void> = timerSleep,
  attempts = 3,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await git(["fetch", "--quiet", "origin"]);
      return;
    } catch (error) {
      if (attempt >= attempts || !isRefLockFailure(error)) throw error;
      await sleep(1_000 * attempt);
    }
  }
}
