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
  | { fallback: false; source: LightPassViewsSource; views: V[]; readStartedAtMs: number }
  | { fallback: true; source: LightPassViewsSource; views: V[]; reason: LightPassViewsFallbackReason; readStartedAtMs: number };

/** `viewReadAtMs[i]` is when `views[i]` was last fully read; `fullyReadCount` counts the views the list's own read read fully. */
interface LastGoodList<V> { views: V[]; viewReadAtMs: number[]; fullyReadCount: number; readStartedAtMs: number; source: LightPassViewsSource }
/** How a view says its rollup was not read (W1-T13195's `rollupUnreadable`), and which PR it is a view of. */
export interface LightPassViewCompleteness<V> { key: (view: V) => string | number; unread: (view: V) => boolean }
type ServedViews<V> = Promise<V[]> & { servedReadStartedAtMs?: number };

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
  /** W1-T13237: without it every view counts as fully read and the list is stored whole. */
  completeness?: LightPassViewCompleteness<V>;
}): { read(served: ServedViews<V> | undefined, own: () => Promise<V[]>, rule?: { boot?: boolean },
  onSource?: (source: LightPassViewsSource) => void): Promise<LightPassViewsRead<V>> } {
  let lastGood: LastGoodList<V> | undefined;
  let inFlight: { promise: Promise<V[]>; readStartedAtMs: number } | undefined;
  /**
   * W1-T13237: a read whose every view was fully read is the list, as before. A view whose rollup was
   * unread never enters it: that PR keeps its previous fully read view (with that view's own read time,
   * so a carried view never outlives the age bound) or is absent, and a pass decides nothing about it.
   */
  const lastGoodFrom = (views: V[], readStartedAtMs: number, source: LightPassViewsSource): LastGoodList<V> => {
    const c = opts.completeness;
    if (c === undefined || !views.some((v) => c.unread(v))) {
      return { views, viewReadAtMs: views.map(() => readStartedAtMs), fullyReadCount: views.length, readStartedAtMs, source };
    }
    const previous = new Map<string | number, { view: V; readAtMs: number }>();
    lastGood?.views.forEach((v, i) => previous.set(c.key(v), { view: v, readAtMs: lastGood?.viewReadAtMs[i] ?? 0 }));
    const kept: V[] = [];
    const keptAt: number[] = [];
    let fullyReadCount = 0;
    for (const v of views) {
      if (!c.unread(v)) { kept.push(v); keptAt.push(readStartedAtMs); fullyReadCount += 1; continue; }
      const before = previous.get(c.key(v));
      if (before !== undefined) { kept.push(before.view); keptAt.push(before.readAtMs); }
    }
    return { views: kept, viewReadAtMs: keptAt, fullyReadCount, readStartedAtMs, source };
  };
  const keep = (read: Promise<V[]>, source: LightPassViewsSource, readStartedAtMs: number): Promise<V[]> => {
    read.then((views) => { lastGood = lastGoodFrom(views, readStartedAtMs, source); }, (error: unknown) => {
      // Reason: not erased; the pass that awaits this read gets the same error and writes it to its row.
      void error;
    });
    return read;
  };
  const ownRead = (own: () => Promise<V[]>): Promise<V[]> => {
    if (inFlight !== undefined) return inFlight.promise;
    const readStartedAtMs = opts.clock.now();
    const read = keep(own(), "own_read", readStartedAtMs);
    const flight = { promise: read, readStartedAtMs };
    inFlight = flight;
    const clear = () => { if (inFlight === flight) inFlight = undefined; };
    read.then(clear, clear);
    return read;
  };
  const usable = (): LastGoodList<V> | undefined =>
    lastGood !== undefined && opts.clock.now() - lastGood.readStartedAtMs <= opts.maxAgeMs ? lastGood : undefined;
  const record = (reason: LightPassViewsFallbackReason, error?: unknown): void => {
    opts.log("sweep_light.views_fallback", {
      run_id: opts.runId, reason,
      snapshot_age_ms: lastGood === undefined ? null : opts.clock.now() - lastGood.readStartedAtMs,
      pr_count: lastGood?.views.length ?? 0,
      // W1-T13237: the list's own age, and how many of its views its read read fully.
      list_age_ms: lastGood === undefined ? null : opts.clock.now() - lastGood.readStartedAtMs,
      fully_read_count: lastGood?.fullyReadCount ?? 0,
      ...(error === undefined ? {} : { error: String((error as Error)?.message ?? error) }),
    });
  };
  const fallback = (list: LastGoodList<V>, reason: LightPassViewsFallbackReason, error?: unknown): LightPassViewsRead<V> => {
    record(reason, error);
    return { fallback: true, source: list.source, views: structuredClone(list.views.filter((_v, i) => opts.clock.now() - (list.viewReadAtMs[i] ?? 0) <= opts.maxAgeMs)), reason, readStartedAtMs: list.readStartedAtMs };
  };
  return {
    async read(served, own, rule, onSource) {
      const servedReadStartedAtMs = served?.servedReadStartedAtMs ?? opts.clock.now();
      // W1-T13709: a served list whose read started before the last good list's is older than it; the pass
      // reads its own views. The boot pass keeps the W1-T12236 rule and takes the served list as before.
      const useServed = served !== undefined && (rule?.boot === true || served.servedReadStartedAtMs === undefined
        || lastGood === undefined || servedReadStartedAtMs >= lastGood.readStartedAtMs);
      const pending = useServed ? keep(served, "tick_read", servedReadStartedAtMs) : ownRead(own);
      const source: LightPassViewsSource = useServed ? "tick_read" : "own_read";
      onSource?.(source);
      const readStartedAtMs = useServed ? servedReadStartedAtMs : inFlight?.readStartedAtMs ?? opts.clock.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const slow = new Promise<"slow">((resolve) => {
        timer = setTimeout(() => resolve("slow"), opts.deadlineMs);
        timer.unref?.();
      });
      try {
        const first = await Promise.race([pending, slow]);
        if (first !== "slow") return { fallback: false, source, views: first, readStartedAtMs };
        const list = usable();
        if (list !== undefined) return fallback(list, "slow_read");
        // No list to decide from: wait for the read, as before this task.
        return { fallback: false, source, views: await pending, readStartedAtMs };
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
