/**
 * lib/light-pass-open-pr-list.ts — W1-T12755: the light pass's last good open-PR list.
 *
 * A light pass whose open-PR list read fails (often a rate limit), or has not settled after
 * {@link LIGHT_PASS_VIEWS_DEADLINE_MS}, decides from the last list that read without error, while
 * that list is younger than {@link LIGHT_PASS_VIEWS_FALLBACK_MAX_AGE_MS}. One own list read runs at a
 * time: a pass that finds a read in flight waits on it, and a read still running when a pass goes on
 * becomes the next pass's list. A pass on a last good list reads every head at act time, stands a PR
 * down when that read fails, and names the list's head on every direct merge.
 */
import { armAutoMergeDetailedAsync, assertOperatorMergeUnheld, mergeDirectViaRestAsync, realArmDepsAsync } from "./arm-auto-merge.js";
import type { Clock } from "./clock.js";
import { DEFAULT_GH_CALL_TIMEOUT_MS } from "./github-transport.js";
import { assertLiveWriteAllowed } from "./live-write-guard.js";
import { classifyGhFailure, readLedgerLines } from "./status.js";
import type { BuildSweepEffectsDeps, OpenPrView, SweepDeps } from "./sweep.js";

/** The existing 60 s loop-available budget of one gh call; not a new number. */
export const LIGHT_PASS_VIEWS_DEADLINE_MS = DEFAULT_GH_CALL_TIMEOUT_MS;
/** PRIMARY CONTROL: the oldest last good list a pass may decide from; the W1-T12755 why-file states the value's reason. */
export const LIGHT_PASS_VIEWS_FALLBACK_MAX_AGE_MS = 15 * 60_000;

export type LightPassViewsSource = "tick_read" | "own_read";
export type LightPassViewsFallbackReason = "rate_limited" | "read_failed" | "slow_read" | "no_snapshot" | "snapshot_too_old";

/** One pass's list: the fresh read, or the last good list with the reason it was used. */
export type LightPassViewsRead<V> =
  | { fallback: false; source: LightPassViewsSource; views: V[] }
  | { fallback: true; source: LightPassViewsSource; views: V[]; reason: LightPassViewsFallbackReason };

interface LastGoodList<V> { views: V[]; readAtMs: number; source: LightPassViewsSource }

/** True for GitHub's rate-limit refusal, by the error's stderr or, when the transport kept none, its message. */
function rateLimited(error: unknown): boolean {
  const e = error as { status?: number | null; stderr?: unknown; code?: string; message?: unknown } | undefined;
  return classifyGhFailure(e?.status, String(e?.stderr ?? e?.message ?? error), e?.code) === "rate_limit";
}

/**
 * The hook keeps one of these for its lifetime. `read(served, own)` reads `served` (the tick read) when
 * given, else the one own read; it throws the read's error only when no usable last good list remains,
 * after it wrote `sweep_light.views_fallback` with the reason.
 */
export function createLightPassOpenPrList<V>(opts: {
  clock: Pick<Clock, "now">;
  log: (step: string, extra: Record<string, unknown>) => void;
  runId: string;
  deadlineMs: number;
  maxAgeMs: number;
}): { read(served: Promise<V[]> | undefined, own: () => Promise<V[]>): Promise<LightPassViewsRead<V>> } {
  let lastGood: LastGoodList<V> | undefined;
  let inFlight: Promise<V[]> | undefined;
  const keep = (read: Promise<V[]>, source: LightPassViewsSource): Promise<V[]> => {
    read.then((views) => { lastGood = { views, readAtMs: opts.clock.now(), source }; }, (error: unknown) => {
      // Reason: not erased; the pass that awaits this read gets the same error and writes it to its row.
      void error;
    });
    return read;
  };
  const ownRead = (own: () => Promise<V[]>): Promise<V[]> => {
    if (inFlight !== undefined) return inFlight;
    const read = keep(own(), "own_read");
    inFlight = read;
    const clear = () => { if (inFlight === read) inFlight = undefined; };
    read.then(clear, clear);
    return read;
  };
  const usable = (): LastGoodList<V> | undefined =>
    lastGood !== undefined && opts.clock.now() - lastGood.readAtMs <= opts.maxAgeMs ? lastGood : undefined;
  const record = (reason: LightPassViewsFallbackReason, error?: unknown): void => {
    opts.log("sweep_light.views_fallback", {
      run_id: opts.runId, reason,
      snapshot_age_ms: lastGood === undefined ? null : opts.clock.now() - lastGood.readAtMs,
      pr_count: lastGood?.views.length ?? 0,
      ...(error === undefined ? {} : { error: String((error as Error)?.message ?? error) }),
    });
  };
  const fallback = (list: LastGoodList<V>, reason: LightPassViewsFallbackReason, error?: unknown): LightPassViewsRead<V> => {
    record(reason, error);
    return { fallback: true, source: list.source, views: structuredClone(list.views), reason };
  };
  return {
    async read(served, own) {
      const pending = served === undefined ? ownRead(own) : keep(served, "tick_read");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const slow = new Promise<"slow">((resolve) => {
        timer = setTimeout(() => resolve("slow"), opts.deadlineMs);
        timer.unref?.();
      });
      try {
        const first = await Promise.race([pending, slow]);
        if (first !== "slow") return { fallback: false, source: served === undefined ? "own_read" : "tick_read", views: first };
        const list = usable();
        if (list !== undefined) return fallback(list, "slow_read");
        // No list to decide from: wait for the read, as before this task.
        return { fallback: false, source: served === undefined ? "own_read" : "tick_read", views: await pending };
      } catch (error) {
        const list = usable();
        if (list !== undefined) return fallback(list, rateLimited(error) ? "rate_limited" : "read_failed", error);
        record(lastGood === undefined ? "no_snapshot" : "snapshot_too_old", error);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** A pass on a last good list: every direct merge names the list's head as `expectedHead`, so GitHub refuses a moved head. */
export function mergeAtListHead(listHeads: ReadonlyMap<number, string>, ledgerPath: string): Pick<BuildSweepEffectsDeps, "armImpl"> {
  return {
    armImpl: (prUrl, taskId, deps = realArmDepsAsync(), isDraft) => armAutoMergeDetailedAsync(prUrl, taskId, {
      ...deps,
      mergeDirect: async (url) => {
        const head = listHeads.get(Number(/\/pull\/(\d+)/.exec(url)?.[1]));
        if (head === undefined) throw new Error(`${url} is not on the last good open-PR list — not merging`);
        assertLiveWriteAllowed("gh-pr-merge", `merging ${url} directly at the last good list's head`);
        await mergeDirectViaRestAsync(url, undefined, undefined, head, undefined,
          () => assertOperatorMergeUnheld(url, { ledgerLines: () => readLedgerLines(ledgerPath), say: deps.say })); // ledger-read-intent: live
      },
    }, isDraft),
  };
}

/** A pass on a last good list: a PR whose act-time head cannot be read stands down instead of acting on the old list. */
export function headReadOrStandDown(read: SweepDeps["readLiveState"] | undefined): NonNullable<SweepDeps["readLiveStateAtAct"]> {
  return async (pr: OpenPrView) => {
    const live = await read?.(pr);
    if (live?.ok !== true || live.headSha === undefined) {
      throw new Error(`act-time head of PR #${pr.prNumber} is unreadable on the last good open-PR list — standing down`);
    }
    return live;
  };
}
