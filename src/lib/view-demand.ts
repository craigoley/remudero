/**
 * On-demand keyed views (arch Phase 4, P4-T09; design §1.1 and §1.2).
 *
 * A keyed view like `task?instance=&id=` has 2,647 possible keys, so the worker cannot materialize
 * them all, and computing one on every GET is what the task page did before. A key is built when
 * someone asks for it:
 *
 * - MAIN side ({@link awaitViewDemand}): a GET for a key with no body posts `want{view, key}` to the
 *   read-model worker and waits ASYNCHRONOUSLY, up to {@link VIEW_DEMAND_WAIT_MS}, for the body to
 *   arrive. The event loop is never blocked and SQLite is never touched on main. A key that did not
 *   arrive in time answers 404 `view_not_ready` with `retryMs`; wants in flight are bounded at
 *   {@link VIEW_DEMAND_MAX_PENDING}, and a second read of a key already waited on shares its wait.
 * - WORKER side ({@link createDemandBook}): the keys a view must keep materialized. A key stays while
 *   it was read in the last {@link VIEW_DEMAND_EVICT_MS} (main re-wants a key it serves, at most once
 *   per {@link VIEW_DEMAND_TOUCH_MS}) or while `pinned` names it (an open stream's `?views=` filter),
 *   and is then evicted: its body is dropped from the store and from serve's memory.
 */
import { systemClock, type Clock } from "./clock.js";
import type { ViewBodyEntry } from "./views.js";

/** The one on-demand keyed view so far: `task?instance=&id=` (task-view.ts). */
export const TASK_VIEW_NAME = "task";
/** Views whose keys are built on demand; the read-model view routes ask for a missing key of each. */
export const DEMAND_VIEWS: readonly string[] = [TASK_VIEW_NAME];

/** How long main waits for a wanted key's body before answering 404 `view_not_ready`. */
export const VIEW_DEMAND_WAIT_MS = 300;
/** A key unread this long is evicted. */
export const VIEW_DEMAND_EVICT_MS = 10 * 60_000;
/** PRIMARY CONTROL: wants in flight at once; a want past this is refused at once rather than queued. */
export const VIEW_DEMAND_MAX_PENDING = 64;
/** BACKSTOP: keys a worker keeps live at once; past this the least recently read is evicted early. */
export const VIEW_DEMAND_MAX_KEYS = 512;
/** What a `view_not_ready` tells a client to wait before asking again. */
export const VIEW_DEMAND_RETRY_MS = 500;
/** A served key is re-wanted at most this often, which is what keeps it from being evicted. */
export const VIEW_DEMAND_TOUCH_MS = 60_000;

/** The worker's record of the keys a demand view must keep materialized. */
export interface DemandBook {
  /** A key was read now. True when it was not live before: the view should build it at once. */
  want(view: string, key: string): boolean;
  has(view: string, key: string): boolean;
  /** Every live key of `view`. */
  keys(view: string): string[];
  /** Removes and returns the keys unread for the eviction bound (and any pushed out by the key cap). */
  expire(): Array<{ view: string; key: string }>;
}

export interface DemandBookOptions {
  clock?: Clock;
  evictMs?: number;
  maxKeys?: number;
  /** A key this names is read as of now, so it is never evicted while it does. */
  pinned?: (view: string, key: string) => boolean;
}

export function createDemandBook(opts: DemandBookOptions = {}): DemandBook {
  const clock = opts.clock ?? systemClock;
  const evictMs = opts.evictMs ?? VIEW_DEMAND_EVICT_MS;
  const maxKeys = opts.maxKeys ?? VIEW_DEMAND_MAX_KEYS;
  /** Least recently read first: a read deletes and re-inserts its key. */
  const live = new Map<string, { view: string; key: string; readAt: number }>();
  const overflow: Array<{ view: string; key: string }> = [];
  const idOf = (view: string, key: string): string => `${view}\u0000${key}`;
  return {
    want: (view, key) => {
      const id = idOf(view, key);
      const known = live.has(id);
      live.delete(id);
      live.set(id, { view, key, readAt: clock.now() });
      while (live.size > maxKeys) {
        const [oldest, entry] = live.entries().next().value!;
        live.delete(oldest);
        overflow.push({ view: entry.view, key: entry.key });
      }
      return !known;
    },
    has: (view, key) => live.has(idOf(view, key)),
    keys: (view) => [...live.values()].filter((entry) => entry.view === view).map((entry) => entry.key),
    expire: () => {
      const now = clock.now();
      const gone = overflow.splice(0);
      for (const [id, entry] of live) {
        if (opts.pinned?.(entry.view, entry.key)) entry.readAt = now;
        else if (now - entry.readAt >= evictMs) {
          live.delete(id);
          gone.push({ view: entry.view, key: entry.key });
        }
      }
      return gone;
    },
  };
}

/** What main needs from the read-model worker's handle to ask for a key (views.ts's `ViewBodySource`). */
export interface ViewDemandSource {
  body(view: string, key?: string): ViewBodyEntry | undefined;
  /** Posts `want{view, key}` to the worker; false when there is no worker to ask. */
  want?(view: string, key: string): boolean;
  /** Calls `listener` with each body the worker posts, after it is stored; returns the unsubscribe. */
  onBody?(listener: (entry: ViewBodyEntry) => void): () => void;
}

export type ViewDemandAnswer =
  | { ok: true; entry: ViewBodyEntry }
  | { ok: false; reason: "timeout" | "saturated" | "no_worker"; retryMs: number };

export interface ViewDemandOptions {
  waitMs?: number;
  maxPending?: number;
  retryMs?: number;
  /** Runs `run` after `ms` and returns its cancel; defaults to an unref'd timer. */
  after?: (run: () => void, ms: number) => () => void;
  /** Stamps the want, so a read that follows it does not re-want within {@link VIEW_DEMAND_TOUCH_MS}. */
  clock?: Clock;
}

interface DemandState {
  pending: Map<string, Promise<ViewDemandAnswer>>;
  touchedAt: Map<string, number>;
}

const states = new WeakMap<object, DemandState>();

function stateOf(source: object): DemandState {
  let state = states.get(source);
  if (!state) states.set(source, (state = { pending: new Map(), touchedAt: new Map() }));
  return state;
}

function unrefTimer(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
}

/**
 * Asks the worker for `view`'s `key` and waits for its body, at most {@link VIEW_DEMAND_WAIT_MS}. It
 * resolves, never rejects, and never blocks the loop: the wait is a timer and a listener.
 */
export function awaitViewDemand(source: ViewDemandSource, view: string, key: string, opts: ViewDemandOptions = {}): Promise<ViewDemandAnswer> {
  const retryMs = opts.retryMs ?? VIEW_DEMAND_RETRY_MS;
  const have = source.body(view, key);
  if (have) return Promise.resolve({ ok: true, entry: have });
  const state = stateOf(source);
  const id = `${view}\u0000${key}`;
  const shared = state.pending.get(id);
  if (shared) return shared;
  if (!source.want || !source.onBody) return Promise.resolve({ ok: false, reason: "no_worker", retryMs });
  if (state.pending.size >= (opts.maxPending ?? VIEW_DEMAND_MAX_PENDING)) return Promise.resolve({ ok: false, reason: "saturated", retryMs });
  const subscribe = source.onBody;
  let settled = false;
  const waiting = new Promise<ViewDemandAnswer>((resolve) => {
    let unsubscribe: () => void = () => {};
    let cancel: () => void = () => {};
    const settle = (answer: ViewDemandAnswer): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      cancel();
      state.pending.delete(id);
      resolve(answer);
    };
    unsubscribe = subscribe((entry) => {
      if (entry.view === view && entry.key === key) settle({ ok: true, entry });
    });
    cancel = (opts.after ?? unrefTimer)(() => settle({ ok: false, reason: "timeout", retryMs }), opts.waitMs ?? VIEW_DEMAND_WAIT_MS);
    // The listener is in place before the worker is told, so a body that lands at once is not missed.
    if (source.want!(view, key)) state.touchedAt.set(id, (opts.clock ?? systemClock).now());
    else settle({ ok: false, reason: "no_worker", retryMs });
  });
  // A refusal settles inside the executor, before there is a promise to file.
  if (!settled) state.pending.set(id, waiting);
  return waiting;
}

/**
 * A served key is read again: re-wants it, at most once per {@link VIEW_DEMAND_TOUCH_MS}, so the worker
 * keeps it materialized (and refreshed) for as long as someone keeps reading it.
 */
export function touchViewDemand(source: ViewDemandSource, view: string, key: string, now: number): void {
  if (!source.want) return;
  const state = stateOf(source);
  const id = `${view}\u0000${key}`;
  const last = state.touchedAt.get(id);
  if (last !== undefined && now - last < VIEW_DEMAND_TOUCH_MS) return;
  if (state.touchedAt.size >= VIEW_DEMAND_MAX_KEYS * 2) {
    for (const [other, at] of state.touchedAt) if (now - at >= VIEW_DEMAND_TOUCH_MS) state.touchedAt.delete(other);
  }
  state.touchedAt.set(id, now);
  source.want(view, key);
}
