/**
 * The console's read snapshots: every cached `GET` answers from an in-memory buffer, and compute runs
 * off the request path (stale-while-revalidate). A request only waits on compute when no usable buffer
 * exists (cold, invalidated by a write, or outlived its viewer), and then only under the route budget.
 *
 * - One entry per (reader, url): `/v1/status` carries a per-token recap and `/v1/feedback` a `?status`
 *   filter, so a key without either would hand one reader another's answer.
 * - A buffer younger than its refresh period is served with no compute at all. An older one is served
 *   at once and its refresh starts via `defer` AFTER the response is written.
 * - While a reader keeps reading (within {@link CONSOLE_SNAPSHOT_VIEWER_IDLE_MS}), each entry refreshes
 *   itself every period, so a polled snapshot stays fresh without any request paying for it. The period
 *   is `max(minRefreshMs, COMPUTE_DUTY_DIVISOR x last compute)`: a slow projection refreshes less often
 *   instead of holding the event loop for a fixed share of every interval.
 * - A completed write through serve bumps {@link ConsoleWriteGeneration}, so the next read of every
 *   cached route recomputes instead of showing the operator a snapshot from before their own action.
 */
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { RECAP_ACK_HEADER } from "./board.js";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import { startConsoleProjectionWorker, type ConsoleProjectionWorker } from "./console-projection-worker.js";
import { bearerTokenId } from "./panel-actions.js";
import type { Route } from "./service.js";

export interface ConsoleResponseStaleness {
  /** The response's own data-status, distinct from the transport/cache headers. */
  status: "fresh" | "stale" | "unavailable";
  stale: boolean;
  ageMs: number | null;
  generatedAt: string | null;
  refreshing: boolean;
  budgetMs: number;
  reason?: string;
}

/** Per-path minimum refresh interval. Anything unlisted refreshes at most every 2 s. */
export const CONSOLE_SNAPSHOT_MIN_REFRESH_MS: Readonly<Record<string, number>> = {
  "/v1/status": 2_000,
  "/v1/recent": 2_000,
  "/v1/daemon-health": 5_000,
  "/v1/inbox": 10_000,
  "/v1/repos": 10_000,
  "/v1/feedback": 10_000,
  "/v1/operator-activity": 15_000,
};
const DEFAULT_MIN_REFRESH_MS = 2_000;
export const CONSOLE_SNAPSHOT_VIEWER_IDLE_MS = 60_000;
export const COMPUTE_DUTY_DIVISOR = 10;
const MAX_ENTRIES_PER_ROUTE = 16;

export interface BufferedRouteResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  generatedAtMs: number;
  /** The body parsed as a JSON object once, at refresh; a request then splices `staleness` in as text. */
  jsonObject?: boolean;
}

export class RouteResponseBuffer {
  statusCode = 200;
  headersSent = false;
  private headers: Record<string, string> = {};
  private chunks: string[] = [];

  writeHead(status: number, headers?: OutgoingHttpHeaders): this {
    this.statusCode = status;
    this.headersSent = true;
    for (const [key, value] of Object.entries(headers ?? {})) {
      if (value === undefined) continue;
      this.headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
    }
    return this;
  }

  setHeader(name: string, value: number | string | readonly string[]): this {
    this.headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
    return this;
  }

  end(chunk?: unknown): this {
    if (chunk !== undefined) this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    this.headersSent = true;
    return this;
  }

  write(chunk: unknown): boolean {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    return true;
  }

  buffered(generatedAtMs: number): BufferedRouteResponse {
    return { status: this.statusCode, headers: { ...this.headers }, body: this.chunks.join(""), generatedAtMs };
  }
}

export function responseStaleness(
  nowMs: number,
  generatedAtMs: number | undefined,
  refreshing: boolean,
  budgetMs: number,
  freshForMs: number,
  reason?: string,
): ConsoleResponseStaleness {
  const stale = generatedAtMs === undefined || nowMs - generatedAtMs > freshForMs;
  return {
    status: generatedAtMs === undefined ? "unavailable" : stale ? "stale" : "fresh",
    stale,
    ageMs: generatedAtMs === undefined ? null : Math.max(0, nowMs - generatedAtMs),
    generatedAt: generatedAtMs === undefined ? null : fixedClock(generatedAtMs).iso(),
    refreshing,
    budgetMs,
    ...(reason ? { reason } : {}),
  };
}

function withJsonStaleness(body: unknown, staleness: ConsoleResponseStaleness): string {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return JSON.stringify({ ...(body as Record<string, unknown>), staleness });
  }
  return JSON.stringify({ value: body, staleness });
}

function stalenessHeaders(staleness: ConsoleResponseStaleness): Record<string, string> {
  return {
    "x-rmd-cache-state": staleness.stale ? "stale" : "fresh",
    "x-rmd-cache-age-ms": staleness.ageMs === null ? "unknown" : String(staleness.ageMs),
    ...(staleness.generatedAt ? { "x-rmd-generated-at": staleness.generatedAt } : {}),
  };
}

export function sendStaleJson(res: ServerResponse, status: number, body: unknown, staleness: ConsoleResponseStaleness): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...stalenessHeaders(staleness) });
  res.end(withJsonStaleness(body, staleness));
}

function writeBufferedResponse(res: ServerResponse, cached: BufferedRouteResponse, staleness: ConsoleResponseStaleness): void {
  const headers: Record<string, string> = { ...cached.headers, ...stalenessHeaders(staleness) };
  let body = cached.body;
  if (cached.jsonObject) {
    body = `${body.slice(0, body.lastIndexOf("}"))}${/^\s*\{\s*\}\s*$/.test(body) ? "" : ","}"staleness":${JSON.stringify(staleness)}}`;
  } else if (/application\/json/i.test(headers["content-type"] ?? "")) {
    try {
      body = withJsonStaleness(JSON.parse(cached.body), staleness);
    } catch {
      // Malformed cached JSON keeps its original body; the cache headers still carry staleness.
      body = cached.body;
    }
  }
  res.writeHead(cached.status, headers);
  res.end(body);
}

function isJsonObjectText(buffered: BufferedRouteResponse): boolean {
  if (!/application\/json/i.test(buffered.headers["content-type"] ?? "")) return false;
  try {
    const parsed: unknown = JSON.parse(buffered.body);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    // Malformed JSON is not spliced: writeBufferedResponse's parse path serves it verbatim.
    return false;
  }
}

/** Bumped by every completed write through serve; a snapshot taken before the bump is not served as current. */
export interface ConsoleWriteGeneration {
  current(): number;
  bump(): void;
}

export function createConsoleWriteGeneration(): ConsoleWriteGeneration {
  let generation = 0;
  return { current: () => generation, bump: () => void (generation += 1) };
}

/** Wraps a non-GET route so its completion (success or failure) invalidates every console snapshot. */
export function invalidateSnapshotsOnWrite(route: Route, generation: ConsoleWriteGeneration): Route {
  if (route.method === "GET") return route;
  return {
    ...route,
    handler: async (req, res, ctx) => {
      try {
        await route.handler(req, res, ctx);
      } finally {
        generation.bump();
      }
    },
  };
}

export interface ConsoleSnapshotCacheOptions {
  budgetMs: number;
  /** The route-shaped body served when there is no buffer at all and the live read missed its budget. */
  fallbackBody: (staleness: ConsoleResponseStaleness) => unknown;
  minRefreshMs?: number;
  clock?: Clock;
  generation?: ConsoleWriteGeneration;
  /** Runs a refresh after the current response is written. Default `setImmediate`. */
  defer?: (run: () => void) => void;
  /** Arms the keep-warm refresh. Default an unref'd `setTimeout`. */
  setTimer?: (run: () => void, ms: number) => void;
}

interface SnapshotEntry {
  cached?: BufferedRouteResponse;
  generation: number;
  refreshPromise?: Promise<void>;
  lastError?: string;
  lastReadAtMs: number;
  lastReq: IncomingMessage;
  computeMs: number;
  warmArmed: boolean;
}

function defaultSetTimer(run: () => void, ms: number): void {
  setTimeout(run, ms).unref();
}

export function createConsoleSnapshotCache(route: Route, options: ConsoleSnapshotCacheOptions): { handler: Route["handler"] } {
  const clock = options.clock ?? systemClock;
  const generation = options.generation ?? createConsoleWriteGeneration();
  const minRefreshMs = options.minRefreshMs ?? CONSOLE_SNAPSHOT_MIN_REFRESH_MS[route.path] ?? DEFAULT_MIN_REFRESH_MS;
  const defer = options.defer ?? ((run: () => void) => void setImmediate(run));
  const setTimer = options.setTimer ?? defaultSetTimer;
  const { budgetMs } = options;
  const entries = new Map<string, SnapshotEntry>();

  const periodOf = (entry: SnapshotEntry): number => Math.max(minRefreshMs, entry.computeMs * COMPUTE_DUTY_DIVISOR);
  const viewed = (entry: SnapshotEntry): boolean => clock.now() - entry.lastReadAtMs <= CONSOLE_SNAPSHOT_VIEWER_IDLE_MS;

  const entryFor = (req: IncomingMessage): SnapshotEntry => {
    const key = `${req.headers ? bearerTokenId(req) : "unknown"} ${req.url ?? route.path}`;
    let entry = entries.get(key);
    if (!entry) {
      entry = { generation: -1, lastReadAtMs: clock.now(), lastReq: req, computeMs: 0, warmArmed: false };
      entries.set(key, entry);
      if (entries.size > MAX_ENTRIES_PER_ROUTE) {
        const oldest = [...entries.entries()].sort((a, b) => a[1].lastReadAtMs - b[1].lastReadAtMs)[0];
        entries.delete(oldest[0]);
      }
    }
    return entry;
  };

  const keepWarm = (entry: SnapshotEntry): void => {
    if (minRefreshMs <= 0 || entry.warmArmed || !viewed(entry)) return;
    entry.warmArmed = true;
    setTimer(() => {
      entry.warmArmed = false;
      if (viewed(entry)) void refresh(entry, entry.lastReq);
    }, periodOf(entry));
  };

  const refresh = (entry: SnapshotEntry, req: IncomingMessage): Promise<void> => {
    if (entry.refreshPromise) return entry.refreshPromise;
    const startedAt = clock.now();
    const startedGeneration = generation.current();
    const buffer = new RouteResponseBuffer();
    entry.refreshPromise = (async () => {
      try {
        await route.handler(req, buffer as unknown as ServerResponse, { params: {} });
        const next = buffer.buffered(startedAt);
        entry.cached = { ...next, jsonObject: isJsonObjectText(next) };
        entry.generation = startedGeneration;
        entry.lastError = undefined;
      } catch (error) {
        const reason = String((error as Error)?.message ?? error);
        entry.lastError = reason;
      } finally {
        entry.computeMs = Math.max(0, clock.now() - startedAt);
        entry.refreshPromise = undefined;
        keepWarm(entry);
      }
    })();
    return entry.refreshPromise;
  };

  /** Fresh means within the period this entry refreshes on; a failed last refresh is never fresh. */
  const stalenessOf = (entry: SnapshotEntry, cached: BufferedRouteResponse | undefined): ConsoleResponseStaleness => {
    const staleness = responseStaleness(clock.now(), cached?.generatedAtMs, entry.refreshPromise !== undefined, budgetMs, periodOf(entry) + budgetMs, entry.lastError);
    return entry.lastError !== undefined && cached ? { ...staleness, status: "stale", stale: true } : staleness;
  };

  /** No usable buffer: race the live read against the budget, armed BEFORE the read starts (W1-T3925). */
  const raceRefresh = async (entry: SnapshotEntry, req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"budget">((resolve) => {
      deadlineTimer = setTimeout(() => resolve("budget"), budgetMs);
    });
    const refreshDone = refresh(entry, req);
    const outcome = await Promise.race([refreshDone.then(() => "ready" as const), deadline]);
    clearTimeout(deadlineTimer);
    const cached = entry.cached;
    if (outcome === "ready" && cached && entry.generation === generation.current()) {
      writeBufferedResponse(res, cached, stalenessOf(entry, cached));
      return;
    }
    const staleness = { ...stalenessOf(entry, cached), status: cached ? ("stale" as const) : ("unavailable" as const), stale: true };
    if (cached) {
      writeBufferedResponse(res, cached, staleness);
      return;
    }
    sendStaleJson(res, 200, options.fallbackBody(staleness), staleness);
  };

  const handler: Route["handler"] = async (req, res) => {
    const entry = entryFor(req);
    const wasViewed = viewed(entry);
    entry.lastReadAtMs = clock.now();
    entry.lastReq = req;
    const cached = entry.cached;
    const acknowledges = req.headers?.[RECAP_ACK_HEADER] !== undefined;
    if (!cached || acknowledges || !wasViewed || entry.generation !== generation.current()) {
      await raceRefresh(entry, req, res);
      return;
    }
    const due = clock.now() - cached.generatedAtMs >= periodOf(entry);
    writeBufferedResponse(res, cached, { ...stalenessOf(entry, cached), refreshing: due || entry.refreshPromise !== undefined });
    if (due) defer(() => void refresh(entry, req));
    else keepWarm(entry);
  };

  return { handler };
}

let sharedProjectionWorker: ConsoleProjectionWorker | undefined;
/** The process's one projection worker (W1-T4454): the snapshot cache's heavy refreshes compute there, off serve's loop. */
export function consoleProjectionWorker(): ConsoleProjectionWorker {
  sharedProjectionWorker ??= startConsoleProjectionWorker();
  return sharedProjectionWorker;
}
