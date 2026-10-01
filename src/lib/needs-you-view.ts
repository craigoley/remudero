/**
 * The `needs-you` view (arch Phase 4, P4-T08, design §1.2 "views of views"): every open decision across
 * instances, the inbox's needsYou first page, and each instance's actions and counts, in ONE read.
 *
 * It reads no store. Serve's main thread recomposes it from the bodies the read model already holds
 * (each instance's `now`, the `inbox` view's `section=needsYou` page) whenever one of those moves, so
 * its sources are the union of theirs. An input with no usable body is ABSENT WITH A REASON, never a
 * zero: the instance or inbox carries `reason`, and an `unavailable` source names it.
 */
import { systemClock, type Clock } from "./clock.js";
import { INBOX_VIEW_NAME, INBOX_VIEW_VERSION, type InboxViewData } from "./inbox-view.js";
import type { NowDecision } from "./now-decisions.js";
import { NOW_VIEW_NAME, NOW_VIEW_VERSION, type NowAction, type NowViewData } from "./now-view.js";
import type { ReadModelBodyEntry, ReadModelWorkerHandle } from "./read-model-worker.js";
import { oldestAsOf, viewEtag, type ViewBody, type ViewSource } from "./views.js";

export const NEEDS_YOU_VIEW_NAME = "needs-you";
export const NEEDS_YOU_VIEW_VERSION = 1;
/** The inbox page this view carries. */
export const NEEDS_YOU_INBOX_KEY = "section=needsYou";

export interface NeedsYouInstance {
  instance: string;
  /** Why this instance's `now` body is not here; its counts and actions are then absent. */
  reason?: string;
  counts?: { decisions: number; decisionsMore: number; actions: number };
  actions?: NowAction[];
  decisionsReasons?: NowViewData["decisionsReasons"];
}

export interface NeedsYouData {
  /** Every present instance's open decisions, newest `askedAt` first. */
  decisions: NowDecision[];
  /** The `inbox` view's `section=needsYou` first page. */
  inbox?: Pick<InboxViewData, "items" | "counts" | "page">;
  instances: NeedsYouInstance[];
  /** Why a top-level input is absent: `inbox`, or `instances` when no instance is known yet. */
  reasons?: { inbox?: string; instances?: string };
}

function absentSource(input: string, instance: string, reason: string): ViewSource {
  return { name: `read-model:${input}@${instance}`, asOf: null, state: "unavailable", kind: "read-model", instance, reason };
}

function newestFirst(a: NowDecision, b: NowDecision): number {
  if (a.askedAt !== b.askedAt) return a.askedAt === undefined ? 1 : b.askedAt === undefined ? -1 : a.askedAt < b.askedAt ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The composite's data and sources from the bodies held now; `known` are the instances the worker reported. */
export function composeNeedsYou(bodies: ReadonlyMap<string, ReadModelBodyEntry>, known: Iterable<string>): { data: NeedsYouData; sources: ViewSource[]; generation: number } {
  const nows = new Map<string, ReadModelBodyEntry>();
  let inbox: ReadModelBodyEntry | undefined;
  for (const entry of bodies.values()) {
    if (entry.view === NOW_VIEW_NAME) {
      const instance = new URLSearchParams(entry.key).get("instance");
      if (instance) nows.set(instance, entry);
    } else if (entry.view === INBOX_VIEW_NAME && entry.key === NEEDS_YOU_INBOX_KEY) inbox = entry;
  }
  const names = [...new Set([...known, ...nows.keys()])].sort();
  const sources: ViewSource[] = [];
  const inputs: ReadModelBodyEntry[] = [];
  const decisions: NowDecision[] = [];
  const reasons: NonNullable<NeedsYouData["reasons"]> = {};
  const instances = names.map((instance): NeedsYouInstance => {
    const entry = nows.get(instance);
    const reason = entry === undefined ? "no now body for this instance yet"
      : entry.version !== NOW_VIEW_VERSION ? `its now body is version ${entry.version}; this view reads ${NOW_VIEW_VERSION}` : undefined;
    if (reason !== undefined) {
      sources.push(absentSource(NOW_VIEW_NAME, instance, reason));
      return { instance, reason };
    }
    inputs.push(entry!);
    const data = entry!.body.data as NowViewData;
    decisions.push(...data.decisions);
    return {
      instance,
      counts: { decisions: data.decisions.length, decisionsMore: data.decisionsMore ?? 0, actions: data.actions.length },
      actions: data.actions,
      ...(data.decisionsReasons ? { decisionsReasons: data.decisionsReasons } : {}),
    };
  });
  if (names.length === 0) reasons.instances = "the read model has reported no instance yet";
  let page: NeedsYouData["inbox"];
  if (inbox === undefined) reasons.inbox = "no inbox needsYou page yet";
  else if (inbox.version !== INBOX_VIEW_VERSION) reasons.inbox = `the inbox body is version ${inbox.version}; this view reads ${INBOX_VIEW_VERSION}`;
  else {
    inputs.push(inbox);
    const { items, counts, page: at } = inbox.body.data as InboxViewData;
    page = { items, counts, page: at };
  }
  if (reasons.inbox !== undefined) sources.push(absentSource(INBOX_VIEW_NAME, "core", reasons.inbox));
  const named = new Set(sources.map((s) => s.name));
  for (const source of inputs.flatMap((input) => input.body.sources)) {
    if (named.has(source.name)) continue;
    named.add(source.name);
    sources.push(source);
  }
  const data: NeedsYouData = {
    decisions: decisions.sort(newestFirst), ...(page ? { inbox: page } : {}), instances, ...(Object.keys(reasons).length > 0 ? { reasons } : {}),
  };
  return { data, sources: sources.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)), generation: Math.max(0, ...inputs.map((i) => i.generation)) };
}

/**
 * The read model's handle with the `needs-you` body overlaid: recomposed on each input body the worker
 * posts (and on every read of it, so a dropped input is never served), and posted to body listeners only
 * when its ETag moved, which is what view-events pushes.
 */
export function withNeedsYouView(inner: ReadModelWorkerHandle, clock: Clock = systemClock): ReadModelWorkerHandle {
  let current: ReadModelBodyEntry | undefined;
  const compose = (): ReadModelBodyEntry => {
    const { data, sources, generation } = composeNeedsYou(inner.bodies, inner.state().instances.keys());
    const stale = sources.some((s) => s.state !== "fresh");
    const etag = viewEtag(NEEDS_YOU_VIEW_NAME, NEEDS_YOU_VIEW_VERSION, stale, data);
    if (current?.etag === etag) return current;
    const body: ViewBody = { view: NEEDS_YOU_VIEW_NAME, version: NEEDS_YOU_VIEW_VERSION, generatedAt: clock.iso(), asOf: oldestAsOf(sources), stale, sources, data };
    current = { view: NEEDS_YOU_VIEW_NAME, key: "", version: NEEDS_YOU_VIEW_VERSION, generation, etag, body };
    return current;
  };
  const merged = (): Map<string, ReadModelBodyEntry> => new Map([...inner.bodies, [`${NEEDS_YOU_VIEW_NAME}\u0000`, compose()]]);
  const bodies: ReadonlyMap<string, ReadModelBodyEntry> = {
    get size() { return merged().size; },
    get: (key) => merged().get(key),
    has: (key) => merged().has(key),
    forEach: (fn) => merged().forEach(fn),
    entries: () => merged().entries(),
    keys: () => merged().keys(),
    values: () => merged().values(),
    [Symbol.iterator]: () => merged()[Symbol.iterator](),
  };
  const listeners = new Set<(entry: ReadModelBodyEntry) => void>();
  inner.onBody((entry) => {
    for (const listener of listeners) listener(entry);
    const isInput = entry.view === NOW_VIEW_NAME || (entry.view === INBOX_VIEW_NAME && entry.key === NEEDS_YOU_INBOX_KEY);
    const before = current;
    if (isInput && compose() !== before) for (const listener of listeners) listener(current!);
  });
  return {
    ...inner,
    bodies,
    body: (view, key = "") => (view === NEEDS_YOU_VIEW_NAME && key === "" ? compose() : inner.body(view, key)),
    onBody: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
