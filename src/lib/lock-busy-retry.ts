/**
 * Retry an operation while another holder has its lock, instead of failing the caller on a lock
 * held for seconds. Measured 2026-09-30: 11 of 42 build runs ended "managed checkout refresh
 * refused: another dispatch holds <lock>" because a peer dispatch held the refresh lock while it
 * set up its worktree. Any other failure, or a lock that outlasts the waits, is rethrown as before.
 */
export async function retryWhileLockBusy<T>(
  attempt: () => T,
  isLockBusy: (error: unknown) => boolean,
  opts: {
    log?: (step: string, extra?: Record<string, unknown>) => void;
    sleep?: (ms: number) => Promise<void>;
    waitsMs?: readonly number[];
  } = {},
): Promise<T> {
  const waits = opts.waitsMs ?? [5_000, 10_000, 15_000, 20_000, 25_000];
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let i = 0; ; i++) {
    try {
      return attempt();
    } catch (error) {
      if (i >= waits.length || !isLockBusy(error)) throw error;
      opts.log?.("lock.busy_wait", { attempt: i + 1, wait_ms: waits[i] });
      await sleep(waits[i]!);
    }
  }
}
