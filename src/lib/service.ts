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
import { randomBytes, timingSafeEqual } from "node:crypto";

/** Bearer scope a route (or SSE stream) requires. `write` implies `read`. */
export type Scope = "read" | "write";

/**
 * W1-T404 (MASTER-PLAN §7A/§7): a write-scoped route's CONSEQUENCE class, ruled 2026-08-11 —
 * "one `write` grant reaches all 20 write-scoped routes, so the credential that adds an operator
 * note is the credential that spends the daily budget, executes a skill against the operator's
 * checkout and halts the fleet." Three tiers, by worst outcome of one unintended call:
 *   `low`    — bookkeeping, trivially reversible (an operator note, a feedback entry).
 *   `middle` — reversible but disruptive, or a force multiplier for `high` (STOP, the cost
 *              ceiling — raising it spends nothing, it removes the thing that would have
 *              stopped the spending).
 *   `high`   — spends money or moves code (drain, skills/run, MANUAL approve, inbox approve).
 * PURELY DECLARATIVE on {@link Route} — see that field's own doc for why consequence cannot be
 * derived from the handler. The comparison this ordering backs is {@link writeTierSatisfies}.
 */
export type WriteTier = "low" | "middle" | "high";

const WRITE_TIER_RANK: Record<WriteTier, number> = { low: 1, middle: 2, high: 3 };

/**
 * True iff a `granted` write tier meets a `required` one — higher tiers imply every lower one,
 * the same "write implies read" shape {@link Scope} already has. `undefined` (a grantor that
 * never reported a tier at all) satisfies nothing: the absence of a tier claim is not a claim of
 * the lowest one.
 */
export function writeTierSatisfies(granted: WriteTier | undefined, required: WriteTier): boolean {
  if (!granted) return false;
  return WRITE_TIER_RANK[granted] >= WRITE_TIER_RANK[required];
}

/**
 * design (iii)'s `ci-parity:drift`-shaped completeness check, re-derived from `src/lib/ci-parity.ts`
 * at 0b9d564 rather than a new spelling: given the REAL assembled route table, name every
 * write-scoped route with no declared {@link Route.tier} — the set a caller fails loud on rather
 * than silently defaulting. Empty ⇒ every write route in `routes` is classified.
 */
export function writeRoutesMissingTier(routes: readonly Route[]): string[] {
  return routes.filter((r) => r.scope === "write" && !r.tier).map((r) => `${r.method} ${r.path}`);
}

/**
 * design (iii-a): run {@link writeRoutesMissingTier} and FAIL THE CALLER (throw) rather than
 * merely reporting — the "runs inside the product function" half of the ci-parity:drift shape,
 * stronger than a bare test assertion (see that design note's own W1-T402 contrast). Extracted
 * here, callable directly, so its throw branch is unit-testable without needing the real
 * assembled route table (which never triggers it) to somehow go missing a tier.
 */
export function assertWriteTiersComplete(routes: readonly Route[]): void {
  const missing = writeRoutesMissingTier(routes);
  if (missing.length > 0) {
    throw new Error(`write-scoped route(s) with no declared WriteTier: ${missing.join(", ")}`);
  }
}

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
  /**
   * W1-T404: this route's {@link WriteTier} — DECLARED, never derived (design ii: a single
   * module declares routes at both consequence poles, so no module-level or grep-shaped signal
   * could tell them apart). Meaningful only when `scope === "write"`; every write-scoped route
   * in the REAL assembled table (`serve.ts`'s `buildServeRoutes`) must carry one — see
   * {@link writeRoutesMissingTier}, which that function fails loud on rather than defaulting.
   * Optional on the TYPE (design i-a's chosen encoding) so it never forces every existing
   * read-scoped route literal in `test/` to grow a field it has no use for; enforcement is
   * opt-in via {@link ServiceOptions.enforceWriteTiers}, off by default, so labeling a route here
   * classifies it without changing what it accepts until that flag is turned on.
   */
  tier?: WriteTier;
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

/**
 * W1-T430 (MASTER-PLAN §6A): the auth/identity extension seam — §6A names "notifier, VCS,
 * storage, auth/identity, model routing" as the plugin interfaces that must be first-class,
 * with a stable contract, BEFORE any Pro/hosted code exists ("Pro must attach, never fork").
 * Scope-granting used to be two paths inlined into {@link grantedScopes} with no declared
 * interface a third grantor could implement; this is that interface. The two grantors below
 * ({@link IdentityAuth}'s tailnet identity and the bearer token in {@link ServiceTokens}) are
 * its first two implementations — see {@link createService}, which wires them in that order
 * (identity tried first but purely ADDITIVE, the token the fallback, exactly the pre-seam
 * W1-T371 contract) and appends any `ServiceOptions.providers` after them, so a future grantor
 * (e.g. W1-T431's relay-brokered browser session) attaches without this dispatch changing.
 */
export interface IdentityProvider {
  /** Provenance label carried through to {@link IdentityGrant.provider} — names WHICH provider
   * vouched for a request, distinct from "nobody vouched" (401) vs. "vouched, but underscoped
   * for this route" (403) that {@link createService}'s dispatch already makes. */
  readonly name: string;
  /**
   * Given the request (and whether the matched route allows a `?token=` fallback — true ONLY
   * for the HTML shell document, see {@link Route.allowQueryToken}), return the scopes this
   * provider grants (`read`, `read`+`write`, or an empty set for "recognized, but grants
   * nothing"), or `undefined` if it does not recognize the request's credentials AT ALL. An
   * `undefined` return is not a denial — it means "not my credential, try the next provider";
   * only once every provider in the list answers `undefined` does the request fail closed
   * (401). This is what keeps identity ADDITIVE to the token rather than a replacement: each
   * provider that doesn't apply steps aside instead of asserting a deny.
   */
  grant(req: IncomingMessage, allowQueryToken: boolean): ReadonlySet<Scope> | undefined;
  /**
   * W1-T404: the {@link WriteTier} this provider's `write` grant is entitled to — a property of
   * the PROVIDER, not a per-request decision (mirrors `grant`'s own `read`/`write` set being one
   * fixed grant per grantor). `undefined` (the default for a provider that declares nothing)
   * satisfies no tier at all once {@link ServiceOptions.enforceWriteTiers} is on — silence is
   * never read as the lowest tier. Design (v)'s ruling for the bearer token specifically: an
   * EXISTING write credential resolves to `"low"`, a deliberate, visible break from a token that
   * used to reach every write route — see {@link bearerTokenProvider}.
   */
  readonly writeTier?: WriteTier;
}

/** What {@link createService}'s provider dispatch hands back once some {@link IdentityProvider}
 * recognizes a request: the scopes granted, plus which provider granted them. */
export interface IdentityGrant {
  scopes: ReadonlySet<Scope>;
  provider: string;
  /** W1-T404: the granting provider's {@link IdentityProvider.writeTier}, carried through
   *  unchanged — {@link grantedScopes} never invents a default here. */
  tier?: WriteTier;
}

export interface ServiceOptions {
  tokens: ServiceTokens;
  /** Additive tailnet-identity auth — see {@link IdentityAuth}. Omitted: identity is never consulted, byte-for-byte the pre-W1-T371 behavior. */
  identity?: IdentityAuth;
  /**
   * W1-T430: additional {@link IdentityProvider}s consulted AFTER the two built-in grantors
   * above (tailnet identity, then the bearer token) — the seam a future grantor attaches
   * through without editing this module's dispatch. Optional and empty by default: omitting it
   * is byte-for-byte today's identity-then-token behavior.
   */
  providers?: IdentityProvider[];
  routes?: Route[];
  sse?: SseRoute[];
  /** One ledger line per auth decision / SSE lifecycle event / handler error. */
  log?: (step: string, extra?: Record<string, unknown>) => void;
  /**
   * W1-T404: turns ON the {@link Route.tier} + second-factor mechanism below — OFF by default,
   * so labeling the real 20 write routes with a tier (required for
   * {@link writeRoutesMissingTier}'s completeness check) never changes what a caller can reach
   * until this is set. `rmd serve`'s own production wiring does not set it yet: flipping it on
   * is paired follow-up work with the console's own tier-aware nonce round trip (design vi) —
   * without that client-side half, an operator's existing single write token would silently
   * start 403ing on buttons the shipped client has no way to unblock. The mechanism itself is
   * real and fully exercised over HTTP by `test/write-tier-*.test.ts`, which turn this on.
   */
  enforceWriteTiers?: boolean;
  /**
   * W1-T404 design (iv): the server-issued, single-use, action-and-payload-bound second factor
   * store HIGH-tier routes consult when {@link enforceWriteTiers} is on. Defaults to a fresh
   * {@link createConfirmNonceStore} — one daemon process, no cross-process sharing needed
   * (mirrors {@link ServiceTokens}' own single-process trust model).
   */
  confirmNonces?: ConfirmNonceStore;
}

/**
 * W1-T404 design (iv), ruled 2026-08-13, option (c): one action a {@link ConfirmNonceStore}
 * nonce is issued for or verified against — the EXACT route and payload it authorizes. Binding
 * to the action (not to a time window) is the reasoning the ruling itself records: it creates no
 * standing elevated state a stolen session can spend, and adds no second secret to paste.
 */
export interface ConfirmNonceAction {
  method: Method;
  path: string;
  /** The raw request body text the authorized call will send, byte for byte — never a
   *  re-serialization of a parsed object, which could reorder/drop keys the caller never typed.
   *  A client controls both calls' bytes, so reusing the identical string is trivial for it. */
  payload: string;
}

/**
 * Server-issued, single-use, action-and-payload-bound second factor for HIGH-tier write routes.
 * `issue` proves nothing by itself (any write-scoped caller may request one — it names an
 * action, not a permission); `consume` is what makes it a factor: it verifies AND SPENDS in one
 * step, so a captured nonce can never be replayed, even against the identical action again.
 */
export interface ConfirmNonceStore {
  issue(action: ConfirmNonceAction): string;
  consume(nonce: string, action: ConfirmNonceAction): boolean;
  /** W1-T451: count of entries not yet consumed or swept. Exists ONLY so a test can observe that
   *  eviction actually bounds growth (an unspent nonce alone can't be proven gone through
   *  `issue`/`consume` — both a swept entry and a merely-expired-but-still-present one refuse a
   *  `consume` identically). `createService`'s dispatch never reads this. */
  size(): number;
}

/**
 * W1-T451 design (i): the nonce covers ONE round trip — issue, an operator reads the
 * confirmation, spend — and both a too-short and a too-long TTL are real failure modes.
 * TOO SHORT is a fifth "bound fires on a healthy condition" (this repo already has four:
 * W1-T312's ci-gate wait cap, W1-T380's dry-run deploy ceiling, W1-T382's check-wait bound, the
 * idle-gate ceiling) and the worst kind, because it would fire on an operator who simply read the
 * dialog carefully: reading `This action SPENDS MONEY`, checking the payload and deciding is
 * TENS OF SECONDS, not one. TOO LONG reinstates the standing elevated state the action-binding
 * was chosen to avoid (W1-T404's own ruling). There is no real console client yet to measure (the
 * confirmation UI is future console-arc work), so this is reasoned from the floor up rather than
 * from a generic HTTP timeout: five minutes is roughly two orders of magnitude past the
 * tens-of-seconds floor — room to get distracted mid-read, scroll back, re-check a payload — while
 * still being a materially bounded window, not hours and not indefinite.
 */
export const CONFIRM_NONCE_TTL_MS = 5 * 60 * 1000;

interface StoredConfirmNonce {
  action: ConfirmNonceAction;
  issuedAt: number;
}

/** In-memory default — single daemon process, no persistence needed. `randomToken` is injectable
 *  so a test can assert on a known nonce value; production always uses real `randomBytes`. `now`
 *  is injectable the same way so a test can assert on expiry without sleeping real time;
 *  production always uses real `Date.now`. */
export function createConfirmNonceStore(
  randomToken: () => string = () => randomBytes(24).toString("hex"),
  now: () => number = () => Date.now(),
): ConfirmNonceStore {
  const pending = new Map<string, StoredConfirmNonce>();
  return {
    issue(action) {
      // W1-T451 design (ii): EVICTION IS SEPARATE FROM EXPIRY. A TTL checked only on `consume`
      // fixes the security half (a stale nonce staying spendable) but leaves an unspent nonce in
      // the map forever, because it is never read again — unbounded growth needs its OWN
      // trigger. The daemon's existing sweeps (tmp_sweep, lock_sweep, orphan_sweep,
      // worker_home_sweep) run in the daemon process; this store lives in the serve process, so a
      // daemon tick can't reach it either. Sweep-on-issue is the one option that adds no new
      // clock/timer: amortised over calls to `issue`, bounded by call rate, and every issue call
      // already runs on this process's event loop.
      const nowMs = now();
      // Same age comparison `consume` uses below (`>=`, not `<`) — a nonce exactly at its TTL
      // boundary must be swept here the same way it's refused there.
      for (const [staleNonce, entry] of pending) {
        if (nowMs - entry.issuedAt >= CONFIRM_NONCE_TTL_MS) pending.delete(staleNonce);
      }
      const nonce = randomToken();
      pending.set(nonce, { action, issuedAt: nowMs });
      return nonce;
    },
    consume(nonce, action) {
      const recorded = pending.get(nonce);
      pending.delete(nonce); // single-use regardless of outcome — a wrong guess spends it too.
      if (!recorded) return false;
      // W1-T451 design (iii): does a TTL make the consume-on-mismatch burn better or worse for an
      // attacker who reaches the endpoint? BETTER dominates: it bounds how long a burned
      // confirmation could have been useful (an attacker who burns a nonce also can't wait out an
      // unbounded window and try later), and it doesn't create a materially cheaper denial —
      // burning a nonce is already immediate and free of a wait either way, since the operator's
      // next legitimate attempt needs a freshly issued nonce regardless of whether this one was
      // burned or simply expired. This is analysis only; the burn-on-any-mismatch behavior itself
      // is unchanged.
      if (now() - recorded.issuedAt >= CONFIRM_NONCE_TTL_MS) return false;
      return recorded.action.method === action.method && recorded.action.path === action.path && safeEqual(recorded.action.payload, action.payload);
    },
    size() {
      return pending.size;
    },
  };
}

interface ConfirmNonceRequestBody {
  method: Method;
  path: string;
  payload: string;
}

function validateConfirmNonceRequest(body: unknown): { error: string } | ConfirmNonceRequestBody {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const methods: Method[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
  if (typeof b.method !== "string" || !(methods as string[]).includes(b.method)) return { error: `method must be one of ${methods.join(", ")}` };
  if (typeof b.path !== "string" || !b.path.startsWith("/")) return { error: "path must be a string starting with /" };
  if (typeof b.payload !== "string") return { error: "payload must be a string" };
  return { method: b.method as Method, path: b.path, payload: b.payload };
}

/**
 * `POST /v1/confirm` — design (iv)'s "costs one round trip per high-tier action": names the
 * exact `{method, path, payload}` a subsequent HIGH-tier call will make, and gets back a nonce
 * that one specific call must present (`X-Confirm-Nonce`) to satisfy the second factor. Plain
 * write scope, no tier of its own — requesting a nonce for an action grants nothing by itself;
 * the target route's own tier + nonce check (createService's dispatch) is the real gate. Not
 * mounted by `rmd serve` today (see {@link ServiceOptions.enforceWriteTiers}); exported so a
 * caller that turns enforcement on has the matching issuance route ready to mount.
 */
export function makeConfirmNonceRoute(store: ConfirmNonceStore): Route {
  return {
    method: "POST",
    path: "/v1/confirm",
    scope: "write",
    // A socket error while reading the body is deliberately NOT caught here — it propagates
    // out of this async handler to createService's own dispatch try/catch (500, `service.error`),
    // the same fate every other route's handler already gets on a transport failure. This isn't
    // a client-input problem (jsonAction's 400 shape), so it never pretends to be one.
    handler: async (req, res) => {
      const raw = await readRawBody(req);
      let parsed: unknown;
      try {
        parsed = raw.trim() ? JSON.parse(raw) : {};
      } catch {
        sendJson(res, 400, { error: "invalid_request", detail: "body is not valid JSON" });
        return;
      }
      const validated = validateConfirmNonceRequest(parsed);
      if ("error" in validated) {
        sendJson(res, 400, { error: "invalid_request", detail: validated.error });
        return;
      }
      const nonce = store.issue(validated);
      sendJson(res, 200, { nonce });
    },
  };
}

/** Read + buffer a request body verbatim, never JSON-parsed here — the ONE primitive both
 *  {@link makeConfirmNonceRoute} and createService's dispatch bind a nonce's `payload` against,
 *  so "the exact bytes a client sent" can never drift between the two call sites. Rejects (never
 *  throws synchronously) on a socket error, mirroring panel-actions.ts's own `readJsonBody`. */
function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
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

/** {@link IdentityAuth}'s tailnet-identity grantor, wrapped as an {@link IdentityProvider} —
 * W1-T430's seam, first adopter #1. `allowQueryToken` is irrelevant here (identity headers,
 * never a query param), so the wrapper ignores it. */
function tailscaleIdentityProvider(identity: IdentityAuth): IdentityProvider {
  return {
    name: "tailscale-identity",
    grant: (req) => identityGrantedScopes(identity, req),
    // W1-T404: unchanged from before tiers existed — the interface+allowlist gates in
    // IdentityAuth's own doc are already a stronger proof than a pasted secret, so this
    // grantor keeps reaching every tier once enforcement is on, exactly as it reaches every
    // route today.
    writeTier: "high",
  };
}

/** The bearer-token grantor (`ServiceTokens`, constant-time compare against
 * `state/service-tokens.json`'s loaded values), wrapped as an {@link IdentityProvider} —
 * W1-T430's seam, first adopter #2. The `?token=` query-param fallback is honored only when the
 * caller passes `allowQueryToken` (true only for the HTML shell route, see
 * {@link Route.allowQueryToken}). */
function bearerTokenProvider(tokens: ServiceTokens): IdentityProvider {
  return {
    name: "bearer-token",
    grant: (req, allowQueryToken) => {
      const token = bearerToken(req) ?? (allowQueryToken ? queryToken(req) : undefined);
      if (!token) return undefined;
      if (safeEqual(token, tokens.write)) return READ_WRITE;
      if (safeEqual(token, tokens.read)) return READ_ONLY;
      return undefined;
    },
    // W1-T404 design (v), THE SHARPEST RULING IN THE TASK: an EXISTING write credential
    // resolves to `"low"`, never higher — a deliberate, visible break (once enforcement is on)
    // from a single token that used to reach every write route. Defaulting this to `"high"`
    // would ship the change as a no-op that silently re-grants everything.
    writeTier: "low",
  };
}

/**
 * Dispatch a request across `providers` IN ORDER, returning the first provider's grant (plus
 * its provenance) or `undefined` if none recognize the credentials (401, not 403) —
 * {@link IdentityAuth} tailnet identity is tried FIRST but is purely additive; when it doesn't
 * apply this falls through to the bearer token exactly as before W1-T371, then to any
 * `ServiceOptions.providers` appended after it. W1-T430's seam: this loop is the ENTIRE gate —
 * any provider list, any implementations, dispatch through this exact same code, which is what
 * lets a third grantor (see test/identity-provider-seam.test.ts's fixture) attach without
 * editing this function.
 */
function grantedScopes(
  providers: readonly IdentityProvider[],
  req: IncomingMessage,
  allowQuery: boolean,
): IdentityGrant | undefined {
  for (const provider of providers) {
    const scopes = provider.grant(req, allowQuery);
    if (scopes) return { scopes, provider: provider.name, tier: provider.writeTier };
  }
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
  // W1-T430: identity (if configured), then the bearer token — the pre-seam W1-T371 order,
  // byte-identical — then any extra providers the caller attaches through the seam.
  const providers: IdentityProvider[] = [
    ...(opts.identity ? [tailscaleIdentityProvider(opts.identity)] : []),
    bearerTokenProvider(opts.tokens),
    ...(opts.providers ?? []),
  ];
  // W1-T404: OFF by default — see ServiceOptions.enforceWriteTiers's own doc for why labeling a
  // route's tier must not, by itself, change what it accepts.
  const enforceWriteTiers = opts.enforceWriteTiers ?? false;
  const confirmNonces = opts.confirmNonces ?? createConfirmNonceStore();

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
      const granted = grantedScopes(providers, req, allowQuery);
      if (!granted) {
        log("service.unauthorized", { method, path });
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      if (!granted.scopes.has(requiredScope)) {
        log("service.forbidden", { method, path, required_scope: requiredScope, granted_by: granted.provider });
        sendJson(res, 403, { error: "forbidden", required_scope: requiredScope });
        return;
      }

      // W1-T404: the tier + second-factor gate, entirely additive to the scope check above and
      // a no-op unless BOTH `enforceWriteTiers` is on AND this route declared a tier — see
      // ServiceOptions.enforceWriteTiers's doc for why that is off by default in production.
      if (enforceWriteTiers && route?.tier) {
        if (!writeTierSatisfies(granted.tier, route.tier)) {
          log("service.forbidden_tier", { method, path, required_tier: route.tier, granted_by: granted.provider, granted_tier: granted.tier });
          sendJson(res, 403, { error: "forbidden", required_scope: requiredScope, required_tier: route.tier });
          return;
        }
        if (route.tier === "high") {
          const nonceHeader = req.headers["x-confirm-nonce"];
          const nonce = Array.isArray(nonceHeader) ? nonceHeader[0] : nonceHeader;
          // CONSUMPTION CAVEAT for a future HIGH-tier handler: presenting a nonce drains the
          // request body HERE to bind it to the exact bytes {@link makeConfirmNonceRoute} was
          // told to expect, so a handler reached past this point must not also read `req` as a
          // stream (a second `.on("data")` sees nothing — the body is already gone). Read
          // `ctx`/the already-parsed input instead, or accept this route never needs its own
          // body. `enforceWriteTiers` off (today's default) never reaches this line at all, so
          // no existing handler is affected yet.
          const ok = nonce ? confirmNonces.consume(nonce, { method, path, payload: await readRawBody(req) }) : false;
          if (!ok) {
            log("service.confirm_nonce_refused", { method, path });
            sendJson(res, 403, { error: "confirm_nonce_required" });
            return;
          }
        }
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
