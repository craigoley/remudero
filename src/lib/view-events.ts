/**
 * `GET /v1/views/events`: the console's push channel (arch plan Phase 2, design D1-D4, P2-01/P2-02).
 *
 * One SSE stream tells a console which view bodies changed; the console refetches only those, with
 * `If-None-Match`. The stream carries versions, never bodies, and the version IS the view's ETag, which
 * hashes `{version, stale, data}` only, so an unchanged view keeps its version across a serve restart.
 *
 * - `hello` first, on every connect: the whole `{view: {key: etag}}` map of served bodies plus the views
 *   not switched to `serve`. The client diffs it against what it holds (design D3), so a reconnect after
 *   a recycle or a relay handover needs no event log. `Last-Event-ID` is only logged.
 * - `view` when a served body's ETag changes, from two causes: `body` (the read-model worker posted
 *   a new one) and `judge` (a 1 s sweep re-judges each body's sources, so a stalled projector flips it
 *   stale with no worker message, exactly as a GET would re-judge it).
 * - `: hb` every 25 s, so an idle proxy never cuts the stream.
 * - `handover` ends every stream when serve drains, and a subscriber stalled past its bound.
 * - A small body rides in its `view` event (P2-05); `view.emitted` samples one event per key a minute (P2-07).
 * - KILL SWITCH: `"push": "on"` in the read model's switches.json; absent or `off` answers 404 `push_disabled`, and
 *   switching it off ends every open stream (`handover`) within a sweep.
 *
 * BACKPRESSURE IS LATEST-VALUE-WINS PER KEY (D4): while a socket holds more than the high-water mark, a
 * new event REPLACES the one pending for its key, so memory is bounded by keys, not by time stalled.
 *
 * NOT READ ATTENTION: an open stream never extends serve's recycle patience (coordinator decision; see
 * `stampReadWith` in serve.ts). Refetches are ordinary view reads and are stamped as reads.
 */
import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { systemClock, type Clock } from "./clock.js";
import { ifNoneMatchHits } from "./console-snapshot-cache.js";
import type { ReadModelWorkerHandle } from "./read-model-worker.js";
import type { Route } from "./service.js";
import { oldestAsOf, viewEtag, viewMode, type ViewBodyEntry, type ViewSource } from "./views.js";

export const VIEW_EVENTS_PATH = "/v1/views/events";
export const VIEW_VERSIONS_PATH = "/v1/views/versions";
/** Below Cloudflare's ~100 s idle cut; the same cadence as the status stream. */
export const VIEW_EVENTS_HEARTBEAT_MS = 25_000;
/** How often served bodies are re-judged, so a staleness flip reaches the screen within a second. */
export const VIEW_EVENTS_SWEEP_MS = 1_000;
/** BACKSTOP: bytes a socket may hold before new events coalesce per key instead of being written. */
export const VIEW_EVENTS_HIGH_WATER_BYTES = 64 * 1024;
/** BACKSTOP: how long a subscriber may stay backed up before it is handed over to reconnect. */
export const VIEW_EVENTS_STALL_MS = 60_000;
/** The EventSource reconnect delay the stream advertises. */
export const VIEW_EVENTS_RETRY_MS = 3_000;
/** A judged body this small rides in its `view` event as `body`, exactly as a GET answers it, so it costs no
 *  refetch (design §4.2 lever 1: nav-badge is ~1.5 KB; `now`, ~100 KB, is refetched). */
export const VIEW_EVENTS_INLINE_BYTES = 4 * 1024;
/** One `view.emitted` ledger row per key at most this often: a latency sample, not a log of every event. Its
 *  `rowTs` (the newest ledger row the body reflects) and `emittedAt` time the host-side hops on one clock. */
export const VIEW_EMITTED_SAMPLE_MS = 60_000;

/** One served view's version per key, and the views whose switch is not `serve`. */
export interface ViewVersions {
  views: Record<string, Record<string, string>>;
  disabled: string[];
}

export interface ViewEventsOptions {
  /** Every routed view name; a name not switched to `serve` is reported as disabled. */
  names: readonly string[];
  /** Views that serve their body with no switch entry (the read model's own status). */
  servedByDefault?: readonly string[];
  readModel?: Pick<ReadModelWorkerHandle, "bodies" | "body" | "judge" | "switches" | "onBody">;
  clock?: Clock;
  bootId?: string;
  every?: (run: () => void, ms: number) => () => void;
  log?: (step: string, extra?: Record<string, unknown>) => void;
  highWaterBytes?: number;
  stallMs?: number;
  inlineBytes?: number;
  /** Told of each subscriber change with the count after it: an open, a client close, or a handover and its reason. */
  onSubscribers?: (change: "open" | "close" | "handover", subscribers: number, reason?: string) => void;
}

export interface ViewEvents {
  /** `GET /v1/views/events` and `GET /v1/views/versions`. */
  routes: Route[];
  /** Ends every open stream with a `handover` event; each client's reconnect resyncs from `hello`. */
  handover(reason: string): void;
  subscribers(): number;
}

interface Subscriber {
  res: ServerResponse;
  views?: ReadonlySet<string>;
  pending: Map<string, string>;
  backedSince?: number;
}

interface Judged {
  entry: ViewBodyEntry;
  etag: string;
  stale: boolean;
  asOf: string | null;
  sources: ViewSource[];
}

/** The newest row a body reflects: the latest `asOf` among its `ledger:<instance>` sources. */
function newestLedgerRow(sources: readonly ViewSource[]): string | null {
  return sources.filter((source) => source.name.startsWith("ledger:") && source.asOf !== null).map((source) => source.asOf!).sort().pop() ?? null;
}

function everyUnref(run: () => void, ms: number): () => void {
  const timer = setInterval(run, ms);
  timer.unref();
  return () => clearInterval(timer);
}

function frame(event: string, data: unknown, id?: string): string {
  return `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createViewEvents(opts: ViewEventsOptions): ViewEvents {
  const clock = opts.clock ?? systemClock;
  const bootId = opts.bootId ?? randomUUID();
  const every = opts.every ?? everyUnref;
  const highWater = opts.highWaterBytes ?? VIEW_EVENTS_HIGH_WATER_BYTES;
  const stallMs = opts.stallMs ?? VIEW_EVENTS_STALL_MS;
  const inlineBytes = opts.inlineBytes ?? VIEW_EVENTS_INLINE_BYTES;
  const sampledAt = new Map<string, number>();
  const subs = new Set<Subscriber>();
  const emitted = new Map<string, string>();
  let seq = 0;
  let stopRunning: (() => void) | undefined;

  const pushOn = (): boolean => opts.readModel?.switches().push === "on";

  const served = (name: string): boolean => {
    const mode = viewMode(opts.readModel, name);
    return (mode ?? (opts.servedByDefault?.includes(name) ? "serve" : "off")) === "serve";
  };

  /** The same re-judgement a GET applies, so an event's etag is the one the refetch answers with. */
  const judge = (readModel: NonNullable<ViewEventsOptions["readModel"]>, entry: ViewBodyEntry, now: number): Judged => {
    const sources = readModel.judge(entry.body.sources, now);
    const stale = sources.some((source) => source.state !== "fresh");
    const etag = stale === entry.body.stale ? entry.etag : viewEtag(entry.view, entry.version, stale, entry.body.data);
    return { entry, etag, stale, asOf: oldestAsOf(sources), sources };
  };

  const current = (now: number): Map<string, Judged> => {
    const out = new Map<string, Judged>();
    const readModel = opts.readModel;
    if (!readModel) return out;
    for (const [id, entry] of readModel.bodies) if (served(entry.view)) out.set(id, judge(readModel, entry, now));
    return out;
  };

  const versions = (now: number, only?: ReadonlySet<string>): ViewVersions => {
    const views: Record<string, Record<string, string>> = {};
    // Sorted, so the map (and the versions ETag) never depends on the order bodies arrived in.
    for (const [, { entry, etag }] of [...current(now)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (only && !only.has(entry.view)) continue;
      (views[entry.view] ??= {})[entry.key] = etag;
    }
    const disabled = opts.names.filter((name) => !served(name) && (!only || only.has(name))).sort();
    return { views, disabled };
  };

  const end = (sub: Subscriber, reason: string): void => {
    subs.delete(sub);
    if (subs.size === 0) stopRunning?.();
    opts.onSubscribers?.("handover", subs.size, reason);
    if (sub.res.writableEnded) return;
    sub.res.end(frame("handover", { reason, retryMs: 0 }));
    opts.log?.("view_events.handover", { reason, pending: sub.pending.size });
  };

  const stalled = (sub: Subscriber, now: number): boolean => {
    if (sub.backedSince === undefined || now - sub.backedSince <= stallMs) return false;
    end(sub, "slow_consumer");
    return true;
  };

  const deliver = (sub: Subscriber, key: string, text: string, now: number): void => {
    if (sub.pending.size === 0 && sub.res.writableLength <= highWater) {
      sub.res.write(text);
      return;
    }
    sub.pending.set(key, text);
    sub.backedSince ??= now;
    stalled(sub, now);
  };

  const flush = (sub: Subscriber): void => {
    for (const text of sub.pending.values()) sub.res.write(text);
    sub.pending.clear();
    sub.backedSince = undefined;
  };

  const emit = (judged: Judged, cause: "body" | "judge", now: number): void => {
    const { entry, etag, stale, asOf, sources } = judged;
    const id = `${entry.view}\u0000${entry.key}`;
    if (emitted.get(id) === etag) return;
    emitted.set(id, etag);
    seq += 1;
    const body = { ...entry.body, stale, asOf, sources };
    const bytes = Buffer.byteLength(JSON.stringify(body));
    const emittedAt = clock.iso();
    const event = { view: entry.view, key: entry.key, etag, stale, emittedAt, asOf, cause };
    const text = frame("view", bytes <= inlineBytes ? { ...event, body } : event, `${bootId}:${seq}`);
    if (now - (sampledAt.get(id) ?? Number.NEGATIVE_INFINITY) >= VIEW_EMITTED_SAMPLE_MS) {
      sampledAt.set(id, now);
      opts.log?.("view.emitted", { view: entry.view, key: entry.key, etag, cause, emittedAt, rowTs: newestLedgerRow(sources), bytes, inline: bytes <= inlineBytes, subscribers: subs.size });
    }
    for (const sub of subs) if (!sub.views || sub.views.has(entry.view)) deliver(sub, id, text, now);
  };

  const sweep = (): void => {
    if (!pushOn()) {
      for (const sub of [...subs]) end(sub, "push_disabled");
      return;
    }
    const now = clock.now();
    for (const judged of current(now).values()) emit(judged, "judge", now);
    for (const sub of subs) stalled(sub, now);
  };

  const heartbeat = (): void => {
    for (const sub of subs) if (sub.pending.size === 0) sub.res.write(": hb\n\n");
  };

  /** Timers and the worker listener exist only while somebody is subscribed. */
  const run = (readModel: NonNullable<ViewEventsOptions["readModel"]>): void => {
    emitted.clear();
    for (const [id, judged] of current(clock.now())) emitted.set(id, judged.etag);
    const stops = [
      readModel.onBody((entry) => {
        if (!served(entry.view)) return;
        const now = clock.now();
        emit(judge(readModel, entry, now), "body", now);
      }),
      every(sweep, VIEW_EVENTS_SWEEP_MS),
      every(heartbeat, VIEW_EVENTS_HEARTBEAT_MS),
    ];
    stopRunning = () => {
      for (const stop of stops) stop();
      stopRunning = undefined;
    };
  };

  const eventsRoute: Route = {
    method: "GET",
    path: VIEW_EVENTS_PATH,
    scope: "read",
    handler: (req: IncomingMessage, res: ServerResponse) => {
      const readModel = opts.readModel;
      if (!readModel) {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "read_model_absent" }));
        return;
      }
      if (!pushOn()) {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "push_disabled" }));
        return;
      }
      const filter = new URL(req.url ?? "/", "http://localhost").searchParams.get("views");
      const views = filter ? new Set(filter.split(",").filter(Boolean)) : undefined;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
        connection: "keep-alive",
      });
      const sub: Subscriber = { res, pending: new Map(), ...(views ? { views } : {}) };
      if (subs.size === 0) run(readModel);
      subs.add(sub);
      const now = clock.now();
      res.write(`retry: ${VIEW_EVENTS_RETRY_MS}\n\n`);
      res.write(frame("hello", { bootId, serverNow: clock.iso(), ...versions(now, views) }, `${bootId}:${seq}`));
      res.on("drain", () => flush(sub));
      req.on("close", () => {
        if (!subs.delete(sub)) return;
        opts.onSubscribers?.("close", subs.size);
        if (subs.size === 0) stopRunning?.();
      });
      opts.onSubscribers?.("open", subs.size);
      opts.log?.("view_events.open", { subscribers: subs.size, ...(req.headers["last-event-id"] ? { lastEventId: String(req.headers["last-event-id"]) } : {}) });
    },
  };

  const versionsRoute: Route = {
    method: "GET",
    path: VIEW_VERSIONS_PATH,
    scope: "read",
    handler: (req, res) => {
      const body = versions(clock.now());
      const etag = `W/"versions.${createHash("sha1").update(JSON.stringify(body)).digest("base64url")}"`;
      if (ifNoneMatchHits(req.headers["if-none-match"], etag)) {
        res.writeHead(304, { etag, "cache-control": "no-cache" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", etag, "cache-control": "no-cache" });
      res.end(JSON.stringify(body));
    },
  };

  return {
    routes: [eventsRoute, versionsRoute],
    handover: (reason) => {
      for (const sub of [...subs]) end(sub, reason);
    },
    subscribers: () => subs.size,
  };
}
