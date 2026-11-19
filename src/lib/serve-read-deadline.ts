/**
 * W1-T11817: on 2026-11-08 every console read reaching serve for half an hour ended "context canceled". The console
 * calls serve with a 5000 ms timeout, and a read that met a stale or cold view was held until the console gave up.
 * A covered read now races a deadline under that timeout. A read past it is counted late in its route family's
 * window. In shadow mode, the default, that is all that happens. In enforce mode the read is answered at once, from
 * the last committed body when one exists, else 503 with retry-after. The abandoned work keeps running for the next
 * reader, and its own late answer is dropped.
 */
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { systemClock, type Clock } from "./clock.js";
import { appendLedger } from "./ledger.js";
import { CONSOLE_CACHED_READ_PATHS } from "./route-read-rollup.js";
import { SERVE_DEMAND_WINDOW_MS } from "./serve-demand.js";
import type { Route } from "./service.js";
import { VIEW_EVENTS_PATH } from "./view-events.js";
import { viewKey, type ViewBodySource } from "./views.js";

export const SERVE_READ_DEADLINE_MS_ENV = "RMD_SERVE_READ_DEADLINE_MS";
export const SERVE_READ_DEADLINE_MODE_ENV = "RMD_SERVE_READ_DEADLINE";
/** The console's own REQUEST_TIMEOUT_MS, the PRIMARY CONTROL that cancels a held read today. The deadline answers below it. */
export const CONSOLE_REQUEST_TIMEOUT_MS = 5000;
export const DEFAULT_SERVE_READ_DEADLINE_MS = 4000;
export const READ_DEADLINE_RETRY_AFTER_S = 5;
export const READ_DEADLINE_STEP = "serve.read_deadline";
const REMEMBERED_READS_CAP = 64;
const INSTANCE_PREFIX = /^\/v1\/i\/[^/]+\//;

export type ReadDeadlineMode = "shadow" | "enforce";
/** A body this read can be answered from: a JSON value (a view body), or the text of an earlier answer. */
export type CommittedRead = { generatedAtMs: number } & ({ body: unknown } | { text: string });
type Outcome = "late" | "stale" | "deferred";

/** Shadow unless the operator writes `enforce`. A deadline that is not a positive integer keeps the default. */
export function readDeadlineConfig(env: NodeJS.ProcessEnv): { mode: ReadDeadlineMode; deadlineMs: number } {
  const ms = Number(env[SERVE_READ_DEADLINE_MS_ENV]);
  return {
    mode: env[SERVE_READ_DEADLINE_MODE_ENV] === "enforce" ? "enforce" : "shadow",
    deadlineMs: Number.isInteger(ms) && ms > 0 ? ms : DEFAULT_SERVE_READ_DEADLINE_MS,
  };
}

/** Only GET reads of a view or of a legacy cached route. Writes, the batch POST and the view event stream are never cut. */
export function readDeadlineCovers(route: Pick<Route, "method" | "scope" | "path">): boolean {
  if (route.method !== "GET" || route.scope !== "read" || route.path === VIEW_EVENTS_PATH) return false;
  const base = route.path.replace(INSTANCE_PREFIX, "/v1/");
  return base.startsWith("/v1/views/") || CONSOLE_CACHED_READ_PATHS.has(base);
}

/** A view route's committed body is the read model's held body for its key. */
export function committedViewBody(source: Pick<ViewBodySource, "body"> | undefined, route: Pick<Route, "path">): ((req: IncomingMessage) => CommittedRead | undefined) | undefined {
  if (!source || !route.path.startsWith("/v1/views/")) return undefined;
  const view = route.path.slice("/v1/views/".length);
  return (req) => {
    const entry = source.body(view, viewKey(new URL(req.url ?? "/", "http://localhost").searchParams));
    return entry && { body: entry.body, generatedAtMs: Date.parse(entry.body.generatedAt) };
  };
}

export interface ReadDeadlineOptions {
  ledgerPath: string;
  mode?: ReadDeadlineMode;
  deadlineMs?: number;
  /** The route family the serve.demand window counts this request under. */
  family: (req: IncomingMessage) => string | undefined;
  clock?: Clock;
  every?: (tick: () => void, ms: number) => () => void;
  log?: (step: string, extra: Record<string, unknown>) => void;
}

export function createReadDeadline(options: ReadDeadlineOptions) {
  const mode = options.mode ?? "shadow";
  const deadlineMs = options.deadlineMs ?? DEFAULT_SERVE_READ_DEADLINE_MS;
  const clock = options.clock ?? systemClock;
  let windowStart = clock.now();
  let families = new Map<string, Record<Outcome, number>>();
  let stopTimer: (() => void) | undefined;
  // The last 200 JSON answer of each legacy read, kept only in enforce mode, as the body a later late read answers from.
  const remembered = new Map<string, CommittedRead>();

  function count(family: string, outcome: Outcome, at = clock.now()): void {
    flush(at);
    let tally = families.get(family);
    if (!tally) families.set(family, tally = { late: 0, stale: 0, deferred: 0 });
    tally[outcome]++;
  }

  /** One row per serve.demand window, keyed by the same route families. */
  function flush(at = clock.now()): void {
    if (at < windowStart + SERVE_DEMAND_WINDOW_MS) return;
    if (families.size > 0) {
      const row = { run_id: "serve", task_id: "", step: READ_DEADLINE_STEP, mode, deadlineMs, windowStart,
        windowEnd: windowStart + SERVE_DEMAND_WINDOW_MS, families: Object.fromEntries(families) };
      try {
        appendLedger(options.ledgerPath, row);
      } catch (error) {
        // Observation must not take down the gateway when its ledger is unavailable.
        (options.log ?? ((step, extra) => console.error(step, extra)))("serve.read_deadline_write_failed", { reason: String(error), windowStart });
      }
    }
    families = new Map();
    windowStart += Math.floor((at - windowStart) / SERVE_DEMAND_WINDOW_MS) * SERVE_DEMAND_WINDOW_MS;
  }

  function start(): () => void {
    if (!stopTimer) {
      windowStart = clock.now();
      stopTimer = options.every ? options.every(flush, SERVE_DEMAND_WINDOW_MS) : (() => {
        const timer = setInterval(flush, SERVE_DEMAND_WINDOW_MS);
        timer.unref();
        return () => clearInterval(timer);
      })();
    }
    return () => { stopTimer?.(); stopTimer = undefined; };
  }

  function answer(res: ServerResponse, held: CommittedRead | undefined): Outcome {
    if (!held) {
      res.writeHead(503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "retry-after": String(READ_DEADLINE_RETRY_AFTER_S) });
      res.end(JSON.stringify({ error: "read_deadline", deadlineMs, retryAfterS: READ_DEADLINE_RETRY_AFTER_S }));
      return "deferred";
    }
    const staleMs = Math.max(0, clock.now() - held.generatedAtMs);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache", "x-rmd-stale": "true",
      "x-rmd-stale-ms": String(Number.isFinite(staleMs) ? staleMs : 0) });
    const body = "body" in held && held.body !== null && typeof held.body === "object" && !Array.isArray(held.body) ? { ...held.body, stale: true } : "body" in held ? held.body : undefined;
    res.end("text" in held ? held.text : JSON.stringify(body));
    return "stale";
  }

  function wrap(route: Route, committed?: (req: IncomingMessage) => CommittedRead | undefined): Route {
    if (!readDeadlineCovers(route)) return route;
    return { ...route, handler: (req, res, ctx) => {
      const family = options.family(req) ?? route.path;
      const remember = mode === "enforce" && !committed ? `${route.path}${new URL(req.url ?? "/", "http://localhost").search}` : undefined;
      let cut = false;
      const timer = setTimeout(() => {
        if (res.writableEnded) return;
        count(family, "late");
        // Shadow only records. A response already begun is never cut.
        if (mode !== "enforce" || res.headersSent) return;
        cut = true;
        count(family, answer(res, committed?.(req) ?? (remember === undefined ? undefined : remembered.get(remember))));
      }, deadlineMs);
      timer.unref();
      const settle = (): void => clearTimeout(timer);
      res.once("finish", settle);
      res.once("close", settle);
      if (mode !== "enforce") return route.handler(req, res, ctx);
      return route.handler(req, cuttable(res, () => cut, remember === undefined ? undefined : (text) => {
        remembered.delete(remember);
        remembered.set(remember, { text, generatedAtMs: clock.now() });
        if (remembered.size > REMEMBERED_READS_CAP) remembered.delete(remembered.keys().next().value!);
      }), ctx);
    } };
  }

  return { mode, deadlineMs, wrap, flush, start };
}

export type ReadDeadline = ReturnType<typeof createReadDeadline>;

/** Serve's one call: wrap a covered read in the deadline, and leave every other route as it is. */
export function withReadDeadline(route: Route, deadline: ReadDeadline, committed?: (req: IncomingMessage) => CommittedRead | undefined): Route {
  return deadline.wrap(route, committed);
}

/**
 * The response the wrapped handler writes to. Once the deadline has answered, its writes are dropped. A 200 JSON answer
 * that is not encoded is offered to `keep` as the body a later late read can answer from.
 */
function cuttable(res: ServerResponse, isCut: () => boolean, keep?: (text: string) => void): ServerResponse {
  let status = 0, headers: OutgoingHttpHeaders = {};
  const chunks: string[] = [];
  const kept = (): void => {
    const type = String(headers["content-type"] ?? res.getHeader("content-type") ?? "");
    const encoded = headers["content-encoding"] ?? res.getHeader("content-encoding");
    if (keep && (status || res.statusCode) === 200 && /application\/json/i.test(type) && encoded === undefined) keep(chunks.join(""));
  };
  const proxy: ServerResponse = new Proxy(res, {
    get(target, prop) {
      if (prop === "writeHead") return (code: number, ...rest: unknown[]) => {
        if (isCut()) return proxy;
        status = code;
        const fields = rest.find((item) => item !== null && typeof item === "object");
        if (fields) headers = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key.toLowerCase(), value]));
        return (target.writeHead as (...args: unknown[]) => ServerResponse)(code, ...rest);
      };
      if (prop === "setHeader") return (name: string, value: number | string | readonly string[]) => isCut() ? proxy : target.setHeader(name, value);
      if (prop === "write") return (chunk: unknown, ...rest: unknown[]) => {
        if (isCut()) return true;
        if (typeof chunk === "string" || Buffer.isBuffer(chunk)) chunks.push(String(chunk));
        return (target.write as (...args: unknown[]) => boolean)(chunk, ...rest);
      };
      if (prop === "end") return (chunk?: unknown, ...rest: unknown[]) => {
        if (isCut()) return proxy;
        if (typeof chunk === "string" || Buffer.isBuffer(chunk)) chunks.push(String(chunk));
        kept();
        return (target.end as (...args: unknown[]) => ServerResponse)(chunk, ...rest);
      };
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
    set(target, prop, value) { return Reflect.set(target, prop, value, target); },
  });
  return proxy;
}
