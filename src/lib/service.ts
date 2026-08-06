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
  /**
   * If true, this route ALSO accepts the bearer credential via a `?token=` query param, not only
   * the `Authorization` header. Set this ONLY on the static HTML document (`GET /`): a browser
   * NAVIGATION cannot send an `Authorization` header, so the shell the operator opens by URL would
   * otherwise 401 and never load (the W1-T139 bootstrap paradox). NEVER set it on an API/data route
   * (`/v1/*`) — a token in the URL leaks via `Referer` and access logs; those stay header-only.
   */
  allowQueryToken?: boolean;
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

/**
 * Tailnet-identity auth, ADDITIVE to the bearer tokens above (W1-T371, MASTER-PLAN §7's
 * auth-endgame — the "preferred" half of W1-T202, token-paste-once being the "acceptable"
 * half that shipped in #892). Consulted BEFORE the bearer token, but only ever ADDS a grant —
 * when it doesn't apply, {@link grantedScopes} falls through to the token check unchanged, so
 * a Tailscale failure degrades to the token rather than locking the operator out.
 *
 * Two independent gates, both required, because they close two different holes:
 *
 * 1. INTERFACE. `trustedLocalAddress` is the interface Tailscale Serve's local proxy target
 *    actually binds — Tailscale's own guidance is "it's best practice to only have the service
 *    listen on localhost" when trusting these headers, because "any user that can call your
 *    service directly (rather than with the Serve URL) could trivially provide their own
 *    values for these HTTP headers" (https://tailscale.com/kb/1312/serve, "Identity headers").
 *    A request landing on any OTHER bound interface — e.g. the tailnet IP this service also
 *    binds directly (RMD_SERVE_HOST) for callers that skip Serve entirely — never reaches the
 *    capability check below, however the header reads: that traffic did not pass through
 *    Serve's own header-spoofing guard ("If Serve finds [identity headers] on an incoming
 *    request, it will remove them for security reasons, to avoid header spoofing"), so nothing
 *    on that interface backs the header's claim. This does not defend against a process
 *    already running ON the trusted machine that dials the trusted address directly — the same
 *    residual trust boundary the bearer-token file (0600, local disk) already accepts.
 *
 * 2. ALLOWLIST. `capability` names a Tailscale ACL app-capability. Serve forwards granted
 *    capabilities as JSON in the `Tailscale-App-Capabilities` header ("If a user or tagged node
 *    that makes a request has been granted any of the app capabilities specified, Serve will
 *    convert them into serialised JSON and forward them" — same doc, "App capabilities
 *    header"). THIS is the allowlist a plain `Tailscale-User-Login` check couldn't be: that
 *    header carries the tailnet account's login, which every device signed in under one
 *    account shares — a phone AND an unattended appliance both read `craigoley@…`. An ACL
 *    grant is evaluated per NODE, not per account, so the phone can be granted the capability
 *    while the appliance is not, and an unlisted node's request simply has no entry for it —
 *    however loudly its `Tailscale-User-Login` claims the same human owns it — and grants
 *    nothing here. (Funnel traffic carries neither header at all — "Funnel traffic, which is
 *    publicly available, does not include identity headers" and app capabilities are
 *    explicitly "not available for Funnel traffic" — so exposing this service over Funnel,
 *    which nothing in this codebase does, would fail closed to the token path, not open.)
 */
export interface IdentityAuth {
  /**
   * Local address (`req.socket.localAddress`) identity headers are honored on. Production
   * wiring (serve.ts) passes the loopback address the Tailscale Serve target binds; a request
   * landing anywhere else never consults `capability` below, forged header or not.
   */
  trustedLocalAddress: string;
  /** The Tailscale ACL app-capability name an allowlisted node/user must be granted — see this interface's own doc. */
  capability: string;
}

export interface ServiceOptions {
  tokens: ServiceTokens;
  /** Additive tailnet-identity auth — see {@link IdentityAuth}. Omitted: identity is never consulted, byte-for-byte the pre-W1-T371 behavior. */
  identity?: IdentityAuth;
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

/**
 * The `?token=` query-param credential — read ONLY for a route that opts into `allowQueryToken`
 * (the HTML shell, reached by a browser NAVIGATION that cannot set an `Authorization` header). It
 * must never be honored on an API/data route: a token in the URL leaks via `Referer` and logs.
 */
function queryToken(req: IncomingMessage): string | undefined {
  const raw = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
  return raw && raw.length > 0 ? raw : undefined;
}

/**
 * Scopes granted by tailnet identity — {@link IdentityAuth}'s two gates, both required.
 * `undefined` whenever either gate fails, which is deliberately indistinguishable from
 * "no identity option configured at all": either way {@link grantedScopes} falls through to
 * the bearer token unchanged, which is exactly the additive-not-a-replacement contract.
 */
function identityGrantedScopes(identity: IdentityAuth | undefined, req: IncomingMessage): ReadonlySet<Scope> | undefined {
  if (!identity) return undefined;
  // Gate 1: INTERFACE. See IdentityAuth's own doc for why a header arriving on any other bound
  // address (e.g. the tailnet IP this service may also bind directly) is never trusted.
  if (req.socket.localAddress !== identity.trustedLocalAddress) return undefined;
  // Gate 2: ALLOWLIST. Serve forwards the connecting node's granted ACL app-capabilities as
  // JSON in this header; an unlisted node's request has no entry for `identity.capability`.
  const raw = req.headers["tailscale-app-capabilities"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header) return undefined;
  let capabilities: unknown;
  try {
    capabilities = JSON.parse(header);
  } catch {
    return undefined; // malformed header -- never a grant, never a crash.
  }
  if (typeof capabilities !== "object" || capabilities === null) return undefined;
  if (!Object.prototype.hasOwnProperty.call(capabilities, identity.capability)) return undefined;
  return READ_WRITE;
}

/**
 * Scopes granted by the request; `undefined` = missing/unrecognized (401, not 403). Tailnet
 * identity (see {@link IdentityAuth}) is tried FIRST but is purely additive — when it doesn't
 * apply, this falls through to the bearer token exactly as before W1-T371. The token header is
 * the ONLY credential source unless `allowQuery` is set (true only for the shell document
 * route), in which case a `?token=` query param is accepted as a fallback for a client that
 * cannot send headers (browser navigation) — never for `/v1/*`.
 */
function grantedScopes(
  tokens: ServiceTokens,
  identity: IdentityAuth | undefined,
  req: IncomingMessage,
  allowQuery: boolean,
): ReadonlySet<Scope> | undefined {
  const identityGrant = identityGrantedScopes(identity, req);
  if (identityGrant) return identityGrant;
  const token = bearerToken(req) ?? (allowQuery ? queryToken(req) : undefined);
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

      // Query-param auth is honored ONLY for a plain route that opted in (the HTML shell) — never
      // for an SSE stream or an API route, where a `?token=` would leak via Referer/logs.
      const allowQuery = !sseRoute && (route?.allowQueryToken ?? false);
      const granted = grantedScopes(opts.tokens, opts.identity, req, allowQuery);
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
