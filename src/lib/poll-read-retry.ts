/**
 * Re-ask one CI-poll GitHub read when it fails transiently, instead of ending the run. Measured
 * 2026-09-28..30: 14 build runs ended "github-read-failed" on one unreadable response or failed
 * `gh api` call while waiting on CI for an already-open PR, and every one of those PRs later merged.
 * Any other error, or a GitHub read that keeps failing past the waits, is rethrown as before.
 */
const GH_READ_FAILURE = /^Command failed: gh |^gh api response body was unreadable/m;

export function isGhReadFailure(error: unknown): boolean {
  return GH_READ_FAILURE.test(error instanceof Error ? error.message : String(error));
}

export async function retryPollRead<T>(
  read: () => Promise<T>,
  opts: {
    log?: (step: string, extra?: Record<string, unknown>) => void;
    sleep?: (ms: number) => Promise<void>;
    waitsMs?: readonly number[];
  } = {},
): Promise<T> {
  const waits = opts.waitsMs ?? [5_000, 10_000, 20_000, 30_000, 60_000];
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let i = 0; ; i++) {
    try {
      return await read();
    } catch (error) {
      if (i >= waits.length || !isGhReadFailure(error)) throw error;
      opts.log?.("poll.read_retry", { attempt: i + 1, wait_ms: waits[i], error: String(error instanceof Error ? error.message : error).slice(0, 160) });
      await sleep(waits[i]!);
    }
  }
}
