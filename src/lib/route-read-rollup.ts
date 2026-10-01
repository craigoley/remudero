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
 */
import type { IncomingMessage } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import { writeAtomic } from "./fs-race-safe.js";
import type { Route } from "./service.js";

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
export interface RouteReadsState {
  version: 1;
  /** When the first rolled-up hour began: no zero streak is longer than the coverage. */
  since: string | null;
  hours: number;
  routes: Record<string, Partial<Record<RouteReadCaller, RouteReadTotals>>>;
}
export interface RouteReadsRow {
  hour: string;
  window_start: string;
  window_end: string;
  partial?: true;
  reads: number;
  routes: Record<string, Partial<Record<RouteReadCaller, number>>>;
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
  routes: Array<{ path: string; kind: "view" | "legacy" | "other"; layers: string[]; zeroConsoleDays: number } & Partial<Record<RouteReadCaller, RouteReadTotals>>>;
}

export interface RouteReadRollup {
  count(path: string, caller: RouteReadCaller): void;
  /** Rolls a finished hour into one row; the timer calls it, and so may a test. */
  tick(): void;
  /** Loads the persisted totals and arms the hourly flush; the returned stop flushes the partial hour. */
  start(): () => void;
  summary(): RouteReadsSummary;
  wrap(route: Route): Route;
}

function emptyState(): RouteReadsState {
  return { version: 1, since: null, hours: 0, routes: {} };
}

function parseState(raw: string): RouteReadsState {
  const parsed = JSON.parse(raw) as Partial<RouteReadsState>;
  if (parsed?.version !== 1 || typeof parsed.routes !== "object" || parsed.routes === null) return emptyState();
  return { version: 1, since: typeof parsed.since === "string" ? parsed.since : null, hours: Number(parsed.hours) || 0, routes: parsed.routes };
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
  return next;
}

export function createRouteReadRollup(opts: {
  stateDir?: string;
  clock?: Clock;
  write?: (row: RouteReadsRow) => void;
  log?: (step: string, extra?: Record<string, unknown>) => void;
  tickMs?: number;
} = {}): RouteReadRollup {
  const clock = opts.clock ?? systemClock;
  const file = opts.stateDir === undefined ? undefined : join(opts.stateDir, ROUTE_READS_FILE);
  let state = emptyState();
  let bucket: number | undefined;
  let windowStart = 0;
  let counts = new Map<string, Record<RouteReadCaller, number>>();
  let last = new Map<string, Partial<Record<RouteReadCaller, string>>>();

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

  const flush = (endMs: number, partial: boolean): void => {
    if (bucket === undefined) return;
    const routes: RouteReadsRow["routes"] = {};
    let reads = 0;
    for (const [path, byCaller] of counts) {
      routes[path] = {};
      for (const caller of CALLERS) if (byCaller[caller] > 0) routes[path]![caller] = byCaller[caller];
      reads += byCaller.console + byCaller.fleet;
    }
    if (partial && reads === 0) return;
    const row: RouteReadsRow = { hour: isoAt(bucket), window_start: isoAt(windowStart),
      window_end: isoAt(endMs), ...(partial ? { partial: true as const } : {}), reads, routes };
    try {
      opts.write?.(row);
    } catch (e) {
      opts.log?.("serve.route_reads.write_failed", { hour: row.hour, reason: String((e as Error)?.message ?? e) });
    }
    // Re-read before folding: an overlapping serve generation folds its own hours into the same file.
    state = fold(readFile(), row, last);
    counts = new Map();
    last = new Map();
    if (!file) return;
    try {
      writeAtomic(file, `${JSON.stringify(state)}\n`);
    } catch (e) {
      opts.log?.("serve.route_reads.persist_failed", { reason: String((e as Error)?.message ?? e) });
    }
  };

  const rollTo = (nowMs: number): void => {
    const hour = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
    if (bucket === undefined) {
      bucket = hour;
      windowStart = nowMs;
    } else if (hour > bucket) {
      flush(bucket + HOUR_MS, false);
      bucket = hour;
      windowStart = hour;
    }
  };

  const summary = (): RouteReadsSummary => {
    const nowMs = clock.now();
    const pending: RouteReadsRow = { hour: "", window_start: isoAt(bucket === undefined ? nowMs : windowStart),
      window_end: clock.iso(), partial: true, reads: 0, routes: Object.fromEntries([...counts].map(([path, byCaller]) => [path, { ...byCaller }])) };
    const merged = fold(state, pending, last);
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
      return { path, kind, layers: legacyLayersOf(path), zeroConsoleDays: streak(totals.console?.lastAt ?? null), ...totals };
    });
    const layers = Object.keys(LEGACY_CACHE_LAYERS).map((layer): RouteReadLayerSummary => {
      const served = routes.filter((r) => r.layers.includes(layer));
      const lastConsoleReadAt = served.reduce<string | null>((acc, r) => later(acc, r.console?.lastAt ?? null), null);
      const zeroConsoleDays = streak(lastConsoleReadAt);
      const windowStartMs = lastConsoleReadAt === null ? sinceMs : Date.parse(lastConsoleReadAt);
      const positiveControl = lastView !== null && Date.parse(lastView) >= windowStartMs;
      return { layer, paths: served.map((r) => r.path), consoleReads: served.reduce((n, r) => n + (r.console?.reads ?? 0), 0), lastConsoleReadAt,
        zeroConsoleDays, positiveControl, gateHolds: positiveControl && zeroConsoleDays >= ROUTE_READS_GATE_DAYS };
    });
    return { asOf: clock.iso(), since: merged.since, hours: merged.hours, gateDays: ROUTE_READS_GATE_DAYS, views: { consoleReads: viewReads, lastConsoleReadAt: lastView }, layers, routes };
  };

  const rollup: RouteReadRollup = {
    count: (path, caller) => {
      const nowMs = clock.now();
      rollTo(nowMs);
      const byCaller = counts.get(path) ?? { console: 0, fleet: 0 };
      byCaller[caller]++;
      counts.set(path, byCaller);
      last.set(path, { ...last.get(path), [caller]: isoAt(nowMs) });
    },
    tick: () => rollTo(clock.now()),
    start: () => {
      state = readFile();
      rollTo(clock.now());
      const timer = setInterval(rollup.tick, opts.tickMs ?? ROUTE_READS_TICK_MS);
      timer.unref();
      return () => {
        clearInterval(timer);
        rollup.tick();
        flush(clock.now(), true);
      };
    },
    summary,
    wrap: (route) => route.method !== "GET" ? route : {
      ...route,
      handler: (req, res, ctx) => {
        rollup.count(route.path, routeReadCaller(req));
        return route.handler(req, res, ctx);
      },
    },
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
