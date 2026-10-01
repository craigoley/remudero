/**
 * Gate G's instrument (Phase 4 design D7, P4-T01): how many reads each legacy route and each view
 * route served, per hour, from the console versus the fleet. COUNTED, NOT LOGGED (the W1-T4394
 * pattern): a read bumps an in-memory counter, and one `serve.route_reads` ledger row per hour
 * carries the hour's counts. The same flush folds them into `<state>/route-reads.json`, so
 * `GET /v1/route-reads` answers "zero console reads for N days" per legacy route and cache layer
 * without reading the ledger, and that GET writes nothing.
 *
 * The caller is the console when the request crossed the Cloudflare edge (the tunnel stamps
 * `cf-ray`/`cf-connecting-ip`; Access adds its own headers); a direct read is the fleet's.
 * A zero is not a measurement without a positive control: each layer reports whether the views
 * that replace it were read by the console inside the same zero window.
 *
 * ONLY THE ACTIVE GENERATION WRITES (the Phase 3 invariant, #8242/#8257): serve calls `start()` when
 * its server is `listening`, the same signal #8242 gates every other background writer on, so a
 * standby counts nothing and writes nothing. A promoted generation starts counting fresh and TAKES
 * OVER THE IN-PROGRESS HOUR: the draining generation's `stop` hands its partial hour to the state
 * file as `carry` (never a ledger row), and whichever generation next closes that hour merges it
 * into the hour's one row. A carry that arrives after its hour was already written rides in the
 * next row, so no hour is ever written twice.
 *
 * The final re-measure (design §9) reads the same rollup, never a probe of serve: per path handler
 * milliseconds from `finish` as a bucket histogram (p50/p99), the view responses served stale by
 * source and phase, and each push stream's subscribers, opens, closes and handovers. Every total is
 * a cumulative counter, so a window is the difference of two reads.
 */
import type { IncomingMessage } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import { writeAtomic } from "./fs-race-safe.js";
import type { Route, SseRoute } from "./service.js";
import type { SourcePhase, ViewBody } from "./views.js";

export const ROUTE_READS_STEP = "serve.route_reads";
export const ROUTE_READS_PATH = "/v1/route-reads";
export const ROUTE_READS_FILE = "route-reads.json";
export const ROUTE_READS_TICK_MS = 60_000;
/** Gate G holds a layer for this many days of zero console reads. */
export const ROUTE_READS_GATE_DAYS = 7;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const isoAt = (ms: number): string => fixedClock(ms).iso();

export type RouteReadCaller = "console" | "fleet";
const CALLERS: readonly RouteReadCaller[] = ["console", "fleet"];
const EDGE_HEADERS = ["cf-ray", "cf-connecting-ip", "cf-access-jwt-assertion", "cf-access-client-id"];

export function routeReadCaller(req: IncomingMessage): RouteReadCaller {
  return EDGE_HEADERS.some((name) => req.headers[name] !== undefined) ? "console" : "fleet";
}

/** The legacy reads the console snapshot cache serves (serve.ts's boundConsoleReadRoute). */
export const CONSOLE_CACHED_READ_PATHS: ReadonlySet<string> = new Set([
  "/v1/status", "/v1/recent", "/v1/inbox", "/v1/daemon-health", "/v1/repos", "/v1/repos/summary", "/v1/feedback", "/v1/operator-activity",
]);
const ROTATION_MEMO_PATHS = new Set(["/v1/action-results", "/v1/operator-activity", "/v1/inbox/attention-census", "/v1/self-measurement"]);
const INSTANCE_PREFIX = /^\/v1\/i\/[^/]+\//;

/** Each legacy cache layer (design §6) and the served paths it answers; `/v1/i/<x>/` copies included. */
export const LEGACY_CACHE_LAYERS: Readonly<Record<string, (base: string, perInstance: boolean) => boolean>> = {
  "snapshot-cache": (base) => CONSOLE_CACHED_READ_PATHS.has(base),
  "board-memo": (base) => base === "/v1/status",
  "rotation-memos": (base) => ROTATION_MEMO_PATHS.has(base) || base.startsWith("/v1/operator-agent/"),
  "repo-index": (base) => base === "/v1/repos" || base === "/v1/repos/summary",
  "analytics-checkpoint": (base) => base === "/v1/analytics",
  "instance-gateways": (base, perInstance) => perInstance && (["/v1/status", "/v1/recent", "/v1/task"].includes(base) || base.startsWith("/v1/repos")),
};

export function legacyLayersOf(path: string): string[] {
  const perInstance = INSTANCE_PREFIX.test(path);
  const base = perInstance ? path.replace(INSTANCE_PREFIX, "/v1/") : path;
  return Object.entries(LEGACY_CACHE_LAYERS).filter(([, serves]) => serves(base, perInstance)).map(([layer]) => layer);
}

export function routeReadKind(path: string): "view" | "legacy" | "other" {
  if (path.startsWith("/v1/views/")) return "view";
  return legacyLayersOf(path).length > 0 ? "legacy" : "other";
}

export interface RouteReadTotals { reads: number; lastAt: string | null }

/** Upper bounds (ms) of the handler-time buckets; a percentile reads as its bucket's bound, capped at the max. */
export const ROUTE_LATENCY_BUCKETS_MS: readonly number[] = [0.25, 0.5, 1, 2, 3, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000];
const OVERFLOW = "+Inf";
export interface RouteLatency { n: number; maxMs: number; buckets: Record<string, number> }
export interface RouteLatencyReading extends RouteLatency { p50Ms: number | null; p99Ms: number | null }

/** Why a stale view source is not fresh, worst last; `none` is a stale source that names no phase. */
export const STALE_PHASE_ORDER: readonly (SourcePhase | "none")[] = ["warming", "refreshing", "catching_up", "behind", "elsewhere", "failed", "none"];
export interface StaleSourceCounts { stale: number; phases: Partial<Record<SourcePhase | "none", number>> }
export interface ViewStaleness {
  served: number;
  stale: number;
  byView: Record<string, { served: number; stale: number }>;
  bySource: Record<string, StaleSourceCounts>;
}
export type RouteReadStream = "views" | "status";
export interface StreamCounts { opened: number; closed: number; peak: number; handovers: Record<string, number> }
export interface RouteReadsState {
  version: 1;
  /** When the first rolled-up hour began: no zero streak is longer than the coverage. */
  since: string | null;
  hours: number;
  routes: Record<string, Partial<Record<RouteReadCaller, RouteReadTotals>>>;
  /** The newest hour a row was written for, so a late carry is never written as a second row. */
  lastHour?: string;
  /** A drained generation's partial hour, waiting for the active one to close that hour. */
  carry?: { row: RouteReadsRow; last: Record<string, Partial<Record<RouteReadCaller, string>>> };
  latency?: Record<string, RouteLatency>;
  staleness?: ViewStaleness;
  streams?: Partial<Record<RouteReadStream, StreamCounts>>;
}
export interface RouteReadsRow {
  hour: string;
  window_start: string;
  window_end: string;
  partial?: true;
  reads: number;
  routes: Record<string, Partial<Record<RouteReadCaller, number>>>;
  latency?: Record<string, RouteLatencyReading>;
  staleness?: ViewStaleness;
  streams?: Partial<Record<RouteReadStream, StreamCounts & { subscribers: number }>>;
}
export interface RouteReadLayerSummary {
  layer: string;
  paths: string[];
  consoleReads: number;
  lastConsoleReadAt: string | null;
  zeroConsoleDays: number;
  /** The replacement views were read by the console inside this layer's zero window. */
  positiveControl: boolean;
  gateHolds: boolean;
}
export interface RouteReadsSummary {
  asOf: string;
  since: string | null;
  hours: number;
  gateDays: number;
  views: { consoleReads: number; lastConsoleReadAt: string | null };
  layers: RouteReadLayerSummary[];
  routes: Array<{ path: string; kind: "view" | "legacy" | "other"; layers: string[]; zeroConsoleDays: number; latency?: RouteLatencyReading } & Partial<Record<RouteReadCaller, RouteReadTotals>>>;
  /** Every view route's handler time together: the "views p99 < 5 ms at serve" target. */
  viewLatency: RouteLatencyReading;
  staleness: ViewStaleness & { worstPhases: Record<string, SourcePhase | "none"> };
  streams: Record<RouteReadStream, StreamCounts & { subscribers: number }>;
}

export interface RouteReadRollup {
  count(path: string, caller: RouteReadCaller): void;
  /** Rolls a finished hour into one row; the timer calls it, and so may a test. */
  tick(): void;
  /** Activates counting (promotion), loads the totals and arms the hourly flush; the returned stop hands the partial hour on once. */
  start(): () => void;
  summary(): RouteReadsSummary;
  /** Counts each GET, and times it from the handler call to the response's `finish` (an event stream is not timed). */
  wrap(route: Route): Route;
  /** One view response answered with this body (200 or 304), stale or not. */
  served(view: string, body: Pick<ViewBody, "stale" | "sources">): void;
  /** A push stream's subscriber change; `subscribers` is the count after it. */
  stream(name: RouteReadStream, change: "open" | "close" | "handover", subscribers: number, reason?: string): void;
  /** Counts a stream route's subscribes and unsubscribes as `name`'s opens and closes. */
  wrapSse(name: RouteReadStream, route: SseRoute): SseRoute;
}

const bucketOf = (ms: number): string => String(ROUTE_LATENCY_BUCKETS_MS.find((bound) => ms <= bound) ?? OVERFLOW);

function addLatency(into: RouteLatency | undefined, from: RouteLatency): RouteLatency {
  const out: RouteLatency = { n: (into?.n ?? 0) + from.n, maxMs: Math.max(into?.maxMs ?? 0, from.maxMs), buckets: { ...into?.buckets } };
  for (const [bucket, n] of Object.entries(from.buckets)) out.buckets[bucket] = (out.buckets[bucket] ?? 0) + n;
  return out;
}

function percentile(latency: RouteLatency, q: number): number | null {
  if (latency.n === 0) return null;
  const rank = Math.ceil(q * latency.n);
  let seen = 0;
  for (const bound of [...ROUTE_LATENCY_BUCKETS_MS.map(String), OVERFLOW]) {
    seen += latency.buckets[bound] ?? 0;
    if (seen >= rank) return bound === OVERFLOW ? latency.maxMs : Math.min(Number(bound), latency.maxMs);
  }
  return latency.maxMs;
}

export function readLatency(latency: RouteLatency): RouteLatencyReading {
  return { ...latency, p50Ms: percentile(latency, 0.5), p99Ms: percentile(latency, 0.99) };
}

export function worstPhase(counts: StaleSourceCounts): SourcePhase | "none" {
  return [...STALE_PHASE_ORDER].reverse().find((phase) => (counts.phases[phase] ?? 0) > 0) ?? "none";
}

const emptyStaleness = (): ViewStaleness => ({ served: 0, stale: 0, byView: {}, bySource: {} });
const emptyStream = (): StreamCounts => ({ opened: 0, closed: 0, peak: 0, handovers: {} });

function addStaleness(into: ViewStaleness | undefined, from: ViewStaleness): ViewStaleness {
  const out: ViewStaleness = { served: (into?.served ?? 0) + from.served, stale: (into?.stale ?? 0) + from.stale, byView: { ...into?.byView }, bySource: { ...into?.bySource } };
  for (const [view, n] of Object.entries(from.byView)) {
    const prior = out.byView[view] ?? { served: 0, stale: 0 };
    out.byView[view] = { served: prior.served + n.served, stale: prior.stale + n.stale };
  }
  for (const [source, n] of Object.entries(from.bySource)) {
    const prior = out.bySource[source] ?? { stale: 0, phases: {} };
    const phases = { ...prior.phases };
    for (const [phase, k] of Object.entries(n.phases) as Array<[SourcePhase | "none", number]>) phases[phase] = (phases[phase] ?? 0) + k;
    out.bySource[source] = { stale: prior.stale + n.stale, phases };
  }
  return out;
}

function addStream(into: StreamCounts | undefined, from: StreamCounts): StreamCounts {
  const out: StreamCounts = { opened: (into?.opened ?? 0) + from.opened, closed: (into?.closed ?? 0) + from.closed,
    peak: Math.max(into?.peak ?? 0, from.peak), handovers: { ...into?.handovers } };
  for (const [reason, n] of Object.entries(from.handovers)) out.handovers[reason] = (out.handovers[reason] ?? 0) + n;
  return out;
}

const STREAMS: readonly RouteReadStream[] = ["views", "status"];

function emptyState(): RouteReadsState {
  return { version: 1, since: null, hours: 0, routes: {} };
}

function parseState(raw: string): RouteReadsState {
  const parsed = JSON.parse(raw) as Partial<RouteReadsState>;
  if (parsed?.version !== 1 || typeof parsed.routes !== "object" || parsed.routes === null) return emptyState();
  return { version: 1, since: typeof parsed.since === "string" ? parsed.since : null, hours: Number(parsed.hours) || 0, routes: parsed.routes,
    ...(typeof parsed.lastHour === "string" ? { lastHour: parsed.lastHour } : {}), ...(parsed.carry?.row ? { carry: parsed.carry } : {}),
    ...(parsed.latency ? { latency: parsed.latency } : {}), ...(parsed.staleness ? { staleness: parsed.staleness } : {}), ...(parsed.streams ? { streams: parsed.streams } : {}) };
}

type LastReads = Map<string, Partial<Record<RouteReadCaller, string>>>;

/** Two generations' counts for one hour as one row: the earlier start, the later end, the reads summed. */
export function mergeRouteReadRows(a: RouteReadsRow, b: RouteReadsRow): RouteReadsRow {
  const routes: RouteReadsRow["routes"] = {};
  for (const row of [a, b]) {
    for (const [path, counts] of Object.entries(row.routes)) {
      const entry = (routes[path] ??= {});
      for (const caller of CALLERS) if (counts[caller]) entry[caller] = (entry[caller] ?? 0) + counts[caller]!;
    }
  }
  const { partial: _drop, ...rest } = a;
  const latency: Record<string, RouteLatency> = {};
  for (const row of [a, b]) for (const [path, l] of Object.entries(row.latency ?? {})) latency[path] = addLatency(latency[path], l);
  const staleness = a.staleness && b.staleness ? addStaleness(a.staleness, b.staleness) : a.staleness ?? b.staleness;
  const streams: NonNullable<RouteReadsRow["streams"]> = {};
  for (const name of STREAMS) {
    const [x, y] = [a.streams?.[name], b.streams?.[name]];
    if (x || y) streams[name] = { ...addStream(x, y ?? emptyStream()), subscribers: x?.subscribers ?? y!.subscribers };
  }
  return { ...rest, window_start: a.window_start < b.window_start ? a.window_start : b.window_start,
    window_end: a.window_end > b.window_end ? a.window_end : b.window_end, reads: a.reads + b.reads, routes,
    ...(Object.keys(latency).length > 0 ? { latency: Object.fromEntries(Object.entries(latency).map(([path, l]) => [path, readLatency(l)])) } : {}),
    ...(staleness ? { staleness } : {}), ...(Object.keys(streams).length > 0 ? { streams } : {}) };
}

function mergeLast(into: LastReads, from: Record<string, Partial<Record<RouteReadCaller, string>>>): void {
  for (const [path, byCaller] of Object.entries(from)) {
    const entry = { ...into.get(path) };
    for (const caller of CALLERS) {
      const at = later(entry[caller] ?? null, byCaller[caller] ?? null);
      if (at !== null) entry[caller] = at;
    }
    into.set(path, entry);
  }
}

const later = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a > b ? a : b);

function fold(state: RouteReadsState, row: RouteReadsRow, last: Map<string, Partial<Record<RouteReadCaller, string>>>): RouteReadsState {
  const next: RouteReadsState = { ...state, since: state.since === null || row.window_start < state.since ? row.window_start : state.since,
    hours: state.hours + (row.partial ? 0 : 1), routes: { ...state.routes } };
  for (const [path, counts] of Object.entries(row.routes)) {
    const entry = { ...next.routes[path] };
    for (const caller of CALLERS) {
      const n = counts[caller] ?? 0;
      if (n === 0) continue;
      const prior = entry[caller] ?? { reads: 0, lastAt: null };
      entry[caller] = { reads: prior.reads + n, lastAt: later(prior.lastAt, last.get(path)?.[caller] ?? row.window_end) };
    }
    next.routes[path] = entry;
  }
  for (const [path, latency] of Object.entries(row.latency ?? {})) next.latency = { ...next.latency, [path]: addLatency(next.latency?.[path], latency) };
  if (row.staleness) next.staleness = addStaleness(next.staleness, row.staleness);
  for (const name of STREAMS) {
    const counts = row.streams?.[name];
    if (counts) next.streams = { ...next.streams, [name]: addStream(next.streams?.[name], counts) };
  }
  return next;
}

export function createRouteReadRollup(opts: {
  stateDir?: string;
  clock?: Clock;
  write?: (row: RouteReadsRow) => void;
  log?: (step: string, extra?: Record<string, unknown>) => void;
  tickMs?: number;
  /** A monotonic millisecond reading for handler times; the default is `performance.now`. */
  elapsed?: () => number;
} = {}): RouteReadRollup {
  const clock = opts.clock ?? systemClock;
  const elapsed = opts.elapsed ?? (() => performance.now());
  const file = opts.stateDir === undefined ? undefined : join(opts.stateDir, ROUTE_READS_FILE);
  let state = emptyState();
  let bucket: number | undefined;
  let windowStart = 0;
  let counts = new Map<string, Record<RouteReadCaller, number>>();
  let last: LastReads = new Map();
  let active = false;
  let latency = new Map<string, RouteLatency>();
  let staleness = emptyStaleness();
  const live: Record<RouteReadStream, number> = { views: 0, status: 0 };
  const freshStreams = (): Record<RouteReadStream, StreamCounts> => ({ views: { ...emptyStream(), peak: live.views }, status: { ...emptyStream(), peak: live.status } });
  let streams = freshStreams();

  const pendingParts = (): Pick<RouteReadsRow, "latency" | "staleness" | "streams"> => {
    const active = STREAMS.filter((name) => live[name] > 0 || streams[name].opened + streams[name].closed + streams[name].peak > 0);
    return {
      ...(latency.size > 0 ? { latency: Object.fromEntries([...latency].map(([path, l]) => [path, readLatency(l)])) } : {}),
      ...(staleness.served > 0 ? { staleness } : {}),
      ...(active.length > 0 ? { streams: Object.fromEntries(active.map((name) => [name, { ...streams[name], subscribers: live[name] }])) } : {}),
    };
  };
  const resetHour = (): void => {
    counts = new Map();
    last = new Map();
    latency = new Map();
    staleness = emptyStaleness();
    streams = freshStreams();
  };

  const readFile = (): RouteReadsState => {
    if (!file) return state;
    try {
      return parseState(readFileSync(file, "utf8"));
    } catch (e) {
      // ENOENT is a serve that has flushed no hour yet; anything else is named, and memory is kept.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") opts.log?.("serve.route_reads.unreadable", { reason: String((e as Error)?.message ?? e) });
      return state;
    }
  };

  const pendingRow = (endMs: number): RouteReadsRow => {
    const routes: RouteReadsRow["routes"] = {};
    let reads = 0;
    for (const [path, byCaller] of counts) {
      routes[path] = {};
      for (const caller of CALLERS) if (byCaller[caller] > 0) routes[path]![caller] = byCaller[caller];
      reads += byCaller.console + byCaller.fleet;
    }
    return { hour: isoAt(bucket!), window_start: isoAt(windowStart), window_end: isoAt(endMs), reads, routes, ...pendingParts() };
  };

  const persist = (next: RouteReadsState): void => {
    state = next;
    if (!file) return;
    try {
      writeAtomic(file, `${JSON.stringify(next)}\n`);
    } catch (e) {
      opts.log?.("serve.route_reads.persist_failed", { reason: String((e as Error)?.message ?? e) });
    }
  };

  const emit = (row: RouteReadsRow): void => {
    try {
      opts.write?.(row);
    } catch (e) {
      opts.log?.("serve.route_reads.write_failed", { hour: row.hour, reason: String((e as Error)?.message ?? e) });
    }
  };

  /** Closes the current hour: its one row, with any carried partial hour merged in or written first. */
  const flush = (endMs: number): void => {
    let row = pendingRow(endMs);
    // Re-read before folding: an overlapping serve generation folds its own hours into the same file.
    let next = readFile();
    const carry = next.carry;
    if (carry && carry.row.hour <= row.hour) {
      const { carry: _taken, ...rest } = next;
      next = rest;
      const carried = new Map<string, Partial<Record<RouteReadCaller, string>>>();
      mergeLast(carried, carry.last);
      if (carry.row.hour === row.hour || (next.lastHour !== undefined && carry.row.hour <= next.lastHour)) {
        const window = carry.row.hour === row.hour ? {} : { window_start: row.window_start, window_end: row.window_end };
        row = mergeRouteReadRows(row, { ...carry.row, hour: row.hour, ...window });
        mergeLast(last, carry.last);
      } else {
        emit({ ...carry.row, partial: true });
        next = { ...fold(next, { ...carry.row, partial: true }, carried), lastHour: carry.row.hour };
      }
    }
    emit(row);
    persist({ ...fold(next, row, last), lastHour: row.hour });
    resetHour();
  };

  /** Hands the active generation's partial hour to the state file once, for its successor to close. */
  const handOff = (endMs: number): void => {
    if (bucket === undefined) return;
    const row = pendingRow(endMs);
    if (row.reads === 0) return;
    const lastReads: LastReads = new Map(last);
    resetHour();
    if (!file) {
      emit({ ...row, partial: true });
      state = fold(state, { ...row, partial: true }, lastReads);
      return;
    }
    const next = readFile();
    let carried = row;
    if (next.carry?.row.hour === row.hour) {
      carried = mergeRouteReadRows(next.carry.row, row);
      mergeLast(lastReads, next.carry.last);
    }
    persist({ ...next, carry: { row: carried, last: Object.fromEntries(lastReads) } });
  };

  const rollTo = (nowMs: number): void => {
    const hour = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
    if (bucket === undefined) {
      bucket = hour;
      windowStart = nowMs;
    } else if (hour > bucket) {
      flush(bucket + HOUR_MS);
      bucket = hour;
      windowStart = hour;
    }
  };

  const summary = (): RouteReadsSummary => {
    const nowMs = clock.now();
    const pending: RouteReadsRow = { hour: "", window_start: isoAt(bucket === undefined ? nowMs : windowStart),
      window_end: clock.iso(), partial: true, reads: 0, routes: Object.fromEntries([...counts].map(([path, byCaller]) => [path, { ...byCaller }])), ...pendingParts() };
    const carriedLast: LastReads = new Map();
    if (state.carry) mergeLast(carriedLast, state.carry.last);
    const merged = fold(state.carry ? fold(state, { ...state.carry.row, partial: true }, carriedLast) : state, pending, last);
    const sinceMs = merged.since === null ? nowMs : Date.parse(merged.since);
    const streak = (lastAt: string | null): number => Math.max(0, Math.floor((nowMs - (lastAt === null ? sinceMs : Date.parse(lastAt))) / DAY_MS));
    let viewReads = 0;
    let lastView: string | null = null;
    const routes: RouteReadsSummary["routes"] = Object.entries(merged.routes).sort(([a], [b]) => a.localeCompare(b)).map(([path, totals]) => {
      const kind = routeReadKind(path);
      if (kind === "view") {
        viewReads += totals.console?.reads ?? 0;
        lastView = later(lastView, totals.console?.lastAt ?? null);
      }
      const timed = merged.latency?.[path];
      return { path, kind, layers: legacyLayersOf(path), zeroConsoleDays: streak(totals.console?.lastAt ?? null), ...(timed ? { latency: readLatency(timed) } : {}), ...totals };
    });
    const viewLatency = readLatency(Object.entries(merged.latency ?? {}).filter(([path]) => routeReadKind(path) === "view")
      .reduce<RouteLatency>((sum, [, l]) => addLatency(sum, l), { n: 0, maxMs: 0, buckets: {} }));
    const stale = merged.staleness ?? emptyStaleness();
    const layers = Object.keys(LEGACY_CACHE_LAYERS).map((layer): RouteReadLayerSummary => {
      const served = routes.filter((r) => r.layers.includes(layer));
      const lastConsoleReadAt = served.reduce<string | null>((acc, r) => later(acc, r.console?.lastAt ?? null), null);
      const zeroConsoleDays = streak(lastConsoleReadAt);
      const windowStartMs = lastConsoleReadAt === null ? sinceMs : Date.parse(lastConsoleReadAt);
      const positiveControl = lastView !== null && Date.parse(lastView) >= windowStartMs;
      return { layer, paths: served.map((r) => r.path), consoleReads: served.reduce((n, r) => n + (r.console?.reads ?? 0), 0), lastConsoleReadAt,
        zeroConsoleDays, positiveControl, gateHolds: positiveControl && zeroConsoleDays >= ROUTE_READS_GATE_DAYS };
    });
    return { asOf: clock.iso(), since: merged.since, hours: merged.hours, gateDays: ROUTE_READS_GATE_DAYS, views: { consoleReads: viewReads, lastConsoleReadAt: lastView }, layers, routes,
      viewLatency, staleness: { ...stale, worstPhases: Object.fromEntries(Object.entries(stale.bySource).map(([source, n]) => [source, worstPhase(n)])) },
      streams: { views: { ...(merged.streams?.views ?? emptyStream()), subscribers: live.views }, status: { ...(merged.streams?.status ?? emptyStream()), subscribers: live.status } } };
  };

  const time = (path: string, raw: number): void => {
    rollTo(clock.now());
    const ms = Math.round(raw * 1000) / 1000;
    const bucket = bucketOf(ms);
    const prior = latency.get(path) ?? { n: 0, maxMs: 0, buckets: {} };
    latency.set(path, { n: prior.n + 1, maxMs: Math.max(prior.maxMs, ms), buckets: { ...prior.buckets, [bucket]: (prior.buckets[bucket] ?? 0) + 1 } });
  };

  const rollup: RouteReadRollup = {
    count: (path, caller) => {
      if (!active) return;
      const nowMs = clock.now();
      rollTo(nowMs);
      const byCaller = counts.get(path) ?? { console: 0, fleet: 0 };
      byCaller[caller]++;
      counts.set(path, byCaller);
      last.set(path, { ...last.get(path), [caller]: isoAt(nowMs) });
    },
    tick: () => rollTo(clock.now()),
    start: () => {
      if (active) return () => {};
      active = true;
      state = readFile();
      bucket = undefined;
      resetHour();
      rollTo(clock.now());
      const timer = setInterval(rollup.tick, opts.tickMs ?? ROUTE_READS_TICK_MS);
      timer.unref();
      return () => {
        if (!active) return;
        clearInterval(timer);
        rollup.tick();
        handOff(clock.now());
        active = false;
      };
    },
    summary,
    wrap: (route) => route.method !== "GET" ? route : {
      ...route,
      handler: (req, res, ctx) => {
        rollup.count(route.path, routeReadCaller(req));
        const started = elapsed();
        res.once("finish", () => {
          if (!String(res.getHeader("content-type") ?? "").startsWith("text/event-stream")) time(route.path, elapsed() - started);
        });
        return route.handler(req, res, ctx);
      },
    },
    served: (view, body) => {
      if (!active) return;
      rollTo(clock.now());
      const byView = staleness.byView[view] ?? { served: 0, stale: 0 };
      staleness.served++;
      byView.served++;
      if (body.stale) {
        staleness.stale++;
        byView.stale++;
      }
      staleness.byView[view] = byView;
      for (const source of body.sources) {
        if (source.state === "fresh") continue;
        const counts = staleness.bySource[source.name] ?? { stale: 0, phases: {} };
        const phase = source.phase ?? "none";
        counts.stale++;
        counts.phases[phase] = (counts.phases[phase] ?? 0) + 1;
        staleness.bySource[source.name] = counts;
      }
    },
    stream: (name, change, subscribers, reason) => {
      if (!active) return;
      rollTo(clock.now());
      live[name] = subscribers;
      const counts = streams[name];
      if (change === "open") counts.opened++;
      else if (change === "close") counts.closed++;
      else counts.handovers[reason ?? "unknown"] = (counts.handovers[reason ?? "unknown"] ?? 0) + 1;
      counts.peak = Math.max(counts.peak, subscribers);
    },
    wrapSse: (name, route) => ({
      ...route,
      subscribe: (send, req) => {
        rollup.stream(name, "open", live[name] + 1);
        const unsubscribe = route.subscribe(send, req);
        let closed = false;
        return () => {
          unsubscribe();
          if (closed) return;
          closed = true;
          rollup.stream(name, "close", Math.max(0, live[name] - 1));
        };
      },
    }),
  };
  return rollup;
}

/** `GET /v1/route-reads`: gate G's evidence, from memory; it reads and writes no file. */
export function buildRouteReadsRoute(rollup: Pick<RouteReadRollup, "summary">): Route {
  return {
    method: "GET",
    path: ROUTE_READS_PATH,
    scope: "read",
    handler: (_req, res) => {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(rollup.summary()));
    },
  };
}
