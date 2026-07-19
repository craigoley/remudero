/**
 * lib/service.ts — the daemon's service surface v0 (W3-T1a, MASTER-PLAN §7A).
 *
 * §7A is the crux this module makes true IN CODE: "the daemon exposes ONE
 * tailnet service surface — REST + SSE, single port, bearer-scoped (read vs.
 * write). No client gets a private backdoor." Three future clients (dashboard,
 * desktop, mobile) plus MCP all talk to this one surface — a daemon with no
 * compile-time contract lets them drift, and drift is runtime breakage no gate
 * catches. This task is split from what it enables (a deliberate DAG, not an
 * oversight): the OpenAPI spec + generated `packages/api-client` is W3-T1b; the
 * no-hand-rolled-fetch grep gate + a consumer whose CI goes red on a breaking
 * change is W3-T1c. Both need a real surface to point at first.
 *
 * SCOPE (one concern): this module is the generic MECHANISM only — same
 * discipline as lib/daemon.ts (pure, testable, every side effect injected).
 * It does not wire a single business endpoint (plan state, fleet control,
 * question/answer). Concrete routes are registered by whoever builds the
 * real `rmd serve`/daemon wiring on top, in a later task — this proves the
 * SURFACE: one HTTP server, one port, bearer-scope enforcement over both
 * plain REST handlers and long-lived SSE streams, with routes/tokens/logging
 * all supplied by the caller.
 *
 * Design notes:
 *  - **Single port.** One `http.Server` serves every route AND every SSE
 *    stream — §7A's "no client gets a private backdoor" starts with there
 *    being nowhere else to knock.
 *  - **Two bearer tokens, two scopes.** `write` is a SUPERSET of `read` (a
 *    write-scoped caller can also read) — mirrors §7's "writes go through the
 *    api-client's write scope" alongside plain reads from the same client.
 *    Comparison is constant-time (`timingSafeEqual`) — a naive `===` leaks a
 *    valid token's length/prefix via response timing.
 *  - **401 vs. 403.** No/unrecognized token → 401 (who are you). A
 *    recognized token whose granted scopes don't cover the route's required
 *    scope → 403 (I know you, you may not). An unknown path is 404
 *    regardless of auth — the route table isn't a secret worth gating.
 *  - **SSE is a subscribe/unsubscribe contract, not an event source.** This
 *    module knows nothing about WHAT gets streamed — a caller-supplied
 *    `subscribe(send)` decides that and returns the cleanup its own event
 *    source needs; this module only owns the wire protocol (headers, framing,
 *    disconnect → unsubscribe).
 *  - **v0 routing is exact-match only** (method + path, no params/wildcards)
 *    — the smallest thing that proves the surface; path params are a
 *    successor's problem, not this one's.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

/** Bearer scope a route (or SSE stream) requires. `write` implies `read`. */
export type Scope = "read" | "write";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Reserved for future path params (v0 routing is exact-match only, so always `{}` today). */
export interface RouteContext {
  params: Record<string, string>;
}

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
) => void | Promise<void>;

/** One plain REST route: an exact `method` + `path` match gated by `scope`. */
export interface Route {
  method: Method;
  path: string;
  scope: Scope;
  handler: RouteHandler;
}

/** Push one SSE event to a subscribed client (`event:`/`data:` framing, owned by this module). */
export type SseSend = (event: string, data: unknown) => void;

/** One SSE stream: an exact GET `path` match gated by `scope`. */
export interface SseRoute {
  path: string;
  scope: Scope;
  /**
   * Called once per client connection, after the scope check passes. Must
   * return an unsubscribe/cleanup function — invoked when the client
   * disconnects (this module never leaks a subscription past that point).
   */
  subscribe: (send: SseSend) => () => void;
}

/** The two bearer tokens this surface accepts. `write` also satisfies `read`-scoped routes. */
export interface ServiceTokens {
  read: string;
  write: string;
}

export interface ServiceOptions {
  tokens: ServiceTokens;
  routes?: Route[];
  sse?: SseRoute[];
  /** One ledger line per auth decision / SSE lifecycle event / handler error. */
  log?: (step: string, extra?: Record<string, unknown>) => void;
}

const READ_ONLY: ReadonlySet<Scope> = new Set<Scope>(["read"]);
const READ_WRITE: ReadonlySet<Scope> = new Set<Scope>(["read", "write"]);

/** Constant-time string compare — a naive `===` leaks a valid token's length/prefix via timing. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  // timingSafeEqual throws on a length mismatch, so the (cheap, length-only) inequality
  // above is checked first — it leaks length, but length alone was never the secret here.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer (.+)$/.exec(header);
  return match?.[1];
}

/** Scopes granted by the request's bearer token; `undefined` = missing/unrecognized (401, not 403). */
function grantedScopes(tokens: ServiceTokens, req: IncomingMessage): ReadonlySet<Scope> | undefined {
  const token = bearerToken(req);
  if (!token) return undefined;
  if (safeEqual(token, tokens.write)) return READ_WRITE;
  if (safeEqual(token, tokens.read)) return READ_ONLY;
  return undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function openSse(req: IncomingMessage, res: ServerResponse, route: SseRoute, path: string, log: NonNullable<ServiceOptions["log"]>): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  // Prime the stream immediately -- the client sees an open 200 connection even
  // before the caller's subscribe() pushes its first real event.
  res.write(":ok\n\n");
  const send: SseSend = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const unsubscribe = route.subscribe(send);
  log("service.sse.open", { path });
  req.on("close", () => {
    unsubscribe();
    log("service.sse.close", { path });
  });
}

/**
 * Build (but do not start) the daemon's single-port service surface. The
 * caller owns `.listen(port)` / `.close()` — this module never touches the
 * network beyond handling requests on the server it returns, matching the
 * rest of `src/lib`'s "no side effect this module didn't get injected"
 * discipline (see lib/daemon.ts's header).
 */
export function createService(opts: ServiceOptions): Server {
  const routes = opts.routes ?? [];
  const sseRoutes = opts.sse ?? [];
  const log = opts.log ?? (() => {});

  return createServer((req, res) => {
    void (async () => {
      const method = (req.method ?? "GET").toUpperCase() as Method;
      const path = new URL(req.url ?? "/", "http://localhost").pathname;

      const sseRoute = method === "GET" ? sseRoutes.find((r) => r.path === path) : undefined;
      const route = sseRoute ? undefined : routes.find((r) => r.method === method && r.path === path);

      if (!sseRoute && !route) {
        sendJson(res, 404, { error: "not_found" });
        return;
      }
      const requiredScope: Scope = (sseRoute ?? route)!.scope;

      const granted = grantedScopes(opts.tokens, req);
      if (!granted) {
        log("service.unauthorized", { method, path });
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      if (!granted.has(requiredScope)) {
        log("service.forbidden", { method, path, required_scope: requiredScope });
        sendJson(res, 403, { error: "forbidden", required_scope: requiredScope });
        return;
      }

      if (sseRoute) {
        openSse(req, res, sseRoute, path, log);
        return;
      }

      try {
        await route!.handler(req, res, { params: {} });
      } catch (e) {
        log("service.error", { method, path, error: String((e as Error)?.message ?? e) });
        if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
      }
    })();
  });
}
