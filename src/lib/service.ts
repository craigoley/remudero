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
import { createPublicKey, randomBytes, timingSafeEqual, verify as verifySignature } from "node:crypto";

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

/**
 * W1-T495 (MASTER-PLAN §7A), ruled 2026-08-14: the READ half of the axis W1-T404 already proved
 * for writes. {@link WriteTier} ranks a write route's consequence (low/middle/high) because
 * writes differ in DEGREE -- an operator note and a budget drain are not equally bad. A read
 * route's sensitivity is not a matter of degree: it either surfaces something an ordinary read
 * grant should never reach on its own (spend, provenance) or it doesn't, so this axis is a
 * single label rather than a rank. Its one value is the label itself; the label's ABSENCE (the
 * field left `undefined`, exactly as an untiered write route defaults under `WriteTier`) is what
 * "ordinary read" means -- silence is never read as an entitlement, the same rule
 * {@link IdentityProvider.writeTier}'s own doc states for tiers. See {@link Route.sensitivity}
 * for the per-route label and {@link IdentityProvider.readSensitivity} for the grant-side
 * entitlement that must match it once {@link ServiceOptions.enforceReadSensitivity} is on.
 */
export type ReadSensitivity = "sensitive";

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
  /**
   * W1-T495: this READ-scoped route's {@link ReadSensitivity} label -- DECLARED, never derived,
   * mirroring {@link tier}'s own reasoning for writes. Meaningful only when `scope === "read"`.
   * Optional on the TYPE so it never forces every existing read-scoped route literal in `test/`
   * to grow a field it has no use for; enforcement is opt-in via
   * {@link ServiceOptions.enforceReadSensitivity}, off by default, so labeling a route here
   * classifies it without changing what it accepts until that flag is turned on. Design (iii):
   * labelling the REAL route table (spread across fourteen modules) is deliberately out of scope
   * for this task -- this field exists so a later task can do that labelling without this module
   * changing again.
   */
  sensitivity?: ReadSensitivity;
  /**
   * W1-T2568 (design i): marks this route SELF-AUTHENTICATED — its handler verifies the
   * caller's identity itself (e.g. GitHub's `X-Hub-Signature-256` HMAC over the RAW request
   * body) rather than through the bearer-token/{@link IdentityProvider} seam every other route
   * dispatches through. That seam cannot fit here: {@link IdentityProvider.grant} is
   * SYNCHRONOUS and receives only `req` (see its own doc — the Cloudflare Access provider's
   * pre-populated key cache is exactly this constraint), while a raw-body HMAC check
   * structurally requires reading (and bounding) the body first. Setting this bypasses
   * `grantedScopes`/tier/sensitivity dispatch ENTIRELY for this one route — no 401/403 is ever
   * produced by the framework, and the handler is SOLELY responsible for its own auth: it must
   * verify before writing anything, fail closed on every invalid input, and use
   * {@link readBoundedRawBody} (never the unbounded internal reader) to cap the body BEFORE
   * buffering it. `scope`/`tier` stay declared for classification/{@link assertWriteTiersComplete}
   * even though this flag means neither is actually enforced. NEVER set this on a route with
   * any pre-existing bearer-token semantics — it removes that gate outright.
   */
  selfAuthenticated?: boolean;
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
  /**
   * W1-T495: whether this provider's `read` grant is entitled to a {@link Route} labelled
   * `sensitivity: "sensitive"` — a property of the PROVIDER, not a per-request decision, mirroring
   * {@link writeTier}'s own shape. `undefined` (the default for a provider that declares nothing)
   * satisfies no sensitive-labelled route at all once {@link ServiceOptions.enforceReadSensitivity}
   * is on — silence is never read as an entitlement, the same rule {@link writeTier} states for
   * tiers.
   */
  readonly readSensitivity?: ReadSensitivity;
}

/** What {@link createService}'s provider dispatch hands back once some {@link IdentityProvider}
 * recognizes a request: the scopes granted, plus which provider granted them. */
export interface IdentityGrant {
  scopes: ReadonlySet<Scope>;
  provider: string;
  /** W1-T404: the granting provider's {@link IdentityProvider.writeTier}, carried through
   *  unchanged — {@link grantedScopes} never invents a default here. */
  tier?: WriteTier;
  /** W1-T495: the granting provider's {@link IdentityProvider.readSensitivity}, carried through
   *  unchanged — {@link grantedScopes} never invents a default here, mirroring {@link tier}. */
  readSensitivity?: ReadSensitivity;
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
   * W1-T404: turns ON the {@link Route.tier} + second-factor mechanism below — OFF by default
   * IN THIS LIBRARY, so labeling the real write routes with a tier (required for
   * {@link writeRoutesMissingTier}'s completeness check) never changes what a caller can reach
   * until this is set. THAT DEFAULT IS THE LIBRARY'S, NOT PRODUCTION'S: `rmd serve` PASSES
   * `enforceWriteTiers: true` (see `buildServeServer` in `src/lib/serve.ts`), shipped by W1-T500,
   * so tier enforcement IS live on the real console. The client-side half this doc once called
   * unshipped paired work — the console's tier-aware nonce round trip — shipped in that same
   * change: {@link makeConfirmNonceRoute} is mounted, so a HIGH-tier refusal is now satisfiable
   * rather than a dead end. The mechanism is also exercised over HTTP by
   * `test/write-tier-*.test.ts`, which turn this on explicitly.
   */
  enforceWriteTiers?: boolean;
  /**
   * W1-T495: turns ON the {@link Route.sensitivity} + grant-side
   * {@link IdentityProvider.readSensitivity} check below — OFF by default, so labeling a read
   * route sensitive never changes what a caller can reach until this is set, the exact
   * precedent {@link enforceWriteTiers} already set (design ii). Ships dark: no provider in this
   * module declares `readSensitivity` and no route in `rmd serve`'s production wiring declares
   * `sensitivity` yet (design iii — labelling the real route table is a separate task); turning
   * this on today would refuse every sensitive-labelled route to every existing grantor, which
   * is exactly why it stays off until both halves of the mechanism have a real caller. The
   * mechanism itself is real and fully exercised over HTTP by `test/read-sensitivity-gate.test.ts`,
   * which turns this on.
   */
  enforceReadSensitivity?: boolean;
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
 * the target route's own tier + nonce check (createService's dispatch) is the real gate. MOUNTED
 * by `rmd serve` since W1-T500 — `buildServeRoutes` (`src/lib/serve.ts`) mounts it as
 * `POST /v1/confirm` with an explicit `tier: "low"`, because this route declares no tier of its
 * own and `assertWriteTiersComplete` requires every write-scoped route to carry one. Still
 * exported separately so another caller that turns enforcement on has the issuance route ready
 * to mount.
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

/**
 * W1-T500: the raw body, MEMOISED ON THE REQUEST. A request stream can be read exactly once, and
 * turning `enforceWriteTiers` on made the HIGH-tier nonce check the FIRST reader — the dispatch
 * drains the body to bind the nonce to the exact bytes, and every HIGH-tier handler then waits
 * forever on a stream that has already ended. That is not hypothetical: it HANGS
 * `/v1/manual/approve`, `/v1/drain/kick`, `/v1/drain/run`, `/v1/inbox/approve` and
 * `/v1/skills/run`, all five of which reach `readJsonBody` through `jsonAction`.
 *
 * The cache is keyed by `Symbol.for` so the two independent readers in this repo — this one and
 * panel-actions.ts's `readJsonBody`, which do NOT share a primitive — resolve the same symbol
 * without importing each other. Whichever reads first buffers; the second gets the bytes rather
 * than an ended stream. `unshift` was rejected as the alternative: it is illegal once `end` has
 * fired, which is exactly when the dispatch finishes reading.
 */
export const RAW_BODY_CACHE = Symbol.for("remudero.service.rawBody");

/** Read + buffer a request body verbatim, never JSON-parsed here — the ONE primitive both
 *  {@link makeConfirmNonceRoute} and createService's dispatch bind a nonce's `payload` against,
 *  so "the exact bytes a client sent" can never drift between the two call sites. Rejects (never
 *  throws synchronously) on a socket error, mirroring panel-actions.ts's own `readJsonBody`. */
function readRawBody(req: IncomingMessage): Promise<string> {
  const cached = (req as unknown as Record<symbol, unknown>)[RAW_BODY_CACHE];
  if (typeof cached === "string") return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      (req as unknown as Record<symbol, unknown>)[RAW_BODY_CACHE] = raw;
      resolve(raw);
    });
    req.on("error", reject);
  });
}

/** W1-T2568 (design i): thrown by {@link readBoundedRawBody} when a request body exceeds the
 *  caller's bound. Later bytes are drained but never buffered, preserving the response socket so
 *  the caller receives the route's explicit 413 instead of a connection reset. */
export class RawBodyTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`request body exceeds the ${maxBytes}-byte bound`);
    this.name = "RawBodyTooLargeError";
  }
}

/**
 * W1-T2568 (design i): the generic "self-authenticated/raw-body route" seam's other half —
 * read + buffer a request body verbatim, EXACTLY like the internal {@link readRawBody} every
 * other route's dispatch already shares (same {@link RAW_BODY_CACHE} symbol, so a route that
 * calls this AFTER `createService`'s own dispatch already drained the body — never true for a
 * `selfAuthenticated` route, which skips that dispatch, but true in principle — still gets the
 * cached bytes rather than a dead stream), but BOUNDED: a body that grows past `maxBytes`
 * rejects with {@link RawBodyTooLargeError} and drains later chunks without retaining them,
 * instead of buffering arbitrarily much attacker-supplied data first. Exported for any self-authenticated route
 * handler (see {@link Route.selfAuthenticated}) — `src/lib/github-event-wake.ts`'s webhook
 * handler is the first caller.
 */
export function readBoundedRawBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const cached = (req as unknown as Record<symbol, unknown>)[RAW_BODY_CACHE];
  if (typeof cached === "string") {
    if (Buffer.byteLength(cached, "utf8") > maxBytes) return Promise.reject(new RawBodyTooLargeError(maxBytes));
    return Promise.resolve(cached);
  }
  return new Promise((resolve, reject) => {
    let receivedBytes = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      receivedBytes += chunk.length;
      if (receivedBytes > maxBytes) {
        settled = true;
        reject(new RawBodyTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString("utf8");
      (req as unknown as Record<symbol, unknown>)[RAW_BODY_CACHE] = raw;
      resolve(raw);
    });
    req.on("error", (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    });
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
 * W1-T531 (MASTER-PLAN §6A, plan_refs W1-T500/W1-T430/W1-T404/W1-T495/W1-T431): the third
 * {@link IdentityProvider}, attached purely through the seam design (i) already proves additive —
 * no change to {@link grantedScopes}, to the two built-in grantors above, or to the tailnet path.
 *
 * Cloudflare Access puts a verified identity in front of a request BEFORE it reaches this
 * process, carried in the `Cf-Access-Jwt-Assertion` header — but Cloudflare's own "Validate JWTs"
 * guidance is explicit that the header's mere PRESENCE is not sufficient to avoid identity
 * spoofing; the JWT's signature, audience, issuer and expiry must all be verified against
 * Cloudflare's own published keys. This is that verification, never the header alone.
 */

/** One JSON Web Key as Cloudflare Access's certs endpoint (`{TEAM_DOMAIN}/cdn-cgi/access/certs`)
 *  returns it — the exact shape `crypto.createPublicKey({ format: "jwk", key })` accepts, so no
 *  third-party JWT library is needed to verify a Cloudflare Access assertion. */
export interface CloudflareAccessJwk {
  kid: string;
  kty: string;
  [field: string]: unknown;
}

/**
 * design (iii): the CACHED key set {@link cloudflareAccessIdentityProvider}'s `grant` reads
 * SYNCHRONOUSLY — `grant` cannot `await` a fetch (rationale 5), so whatever populates this cache
 * does so entirely out of band (see {@link createCloudflareAccessKeyCache}). `keys()` returning
 * `undefined`/empty, or returning a set with no matching `kid`, is a DENIAL for that request —
 * never an inline fetch, never a pinned certificate.
 */
export interface CloudflareAccessKeyCache {
  /** Current JWKS keys, or `undefined` before the first successful fetch. */
  keys(): readonly CloudflareAccessJwk[] | undefined;
  /**
   * Fire-and-forget: called when a request's `kid` isn't in the current cache, so an
   * implementation MAY schedule an out-of-band refresh for the NEXT request (design iii: "a
   * refresh scheduled out of band"). Never awaited by `grant` — a slow or failing refresh must
   * never affect the CURRENT request's synchronous denial. Optional: a cache refreshed purely on
   * its own timer can leave this a no-op.
   */
  scheduleRefresh?(): void;
}

/** Configuration for {@link cloudflareAccessIdentityProvider}. */
export interface CloudflareAccessOptions {
  /** The operator's Cloudflare Access team domain, e.g. `https://example.cloudflareaccess.com` —
   *  checked against the JWT's `iss` claim, and used by {@link createCloudflareAccessKeyCache} to
   *  build the certs endpoint URL. No trailing slash. */
  teamDomain: string;
  /** The Access application's AUD tag — checked against the JWT's `aud` claim (Cloudflare emits
   *  this as an array of one, so a bare string `aud` is also accepted). */
  audience: string;
  /** Out-of-band-refreshed key cache — see {@link CloudflareAccessKeyCache}. */
  keys: CloudflareAccessKeyCache;
  /** Injectable clock, defaults to `Date.now` — lets a test assert on expiry without sleeping. */
  now?: () => number;
  log?: (step: string, extra?: Record<string, unknown>) => void;
}

/** Cloudflare Access signs with RS256 today; RS384/RS512 are accepted defensively since nothing
 *  about the verification changes for them. Any other `alg` (including `none`) is refused. */
const CLOUDFLARE_ACCESS_JWT_ALG_TO_NODE: Record<string, string> = {
  RS256: "RSA-SHA256",
  RS384: "RSA-SHA384",
  RS512: "RSA-SHA512",
};

interface CloudflareAccessClaims {
  aud?: string | string[];
  iss?: string;
  exp?: number;
  [field: string]: unknown;
}

function decodeJwtSegment<T>(segment: string): T {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as T;
}

/**
 * design (iv): every claim checked, ALL of them — signature against the cached key set, `aud`
 * against the configured application tag, issuer against the team domain, and expiry. Header
 * PRESENCE is deliberately not one of them (this function only runs once the header is known
 * present — see {@link cloudflareAccessIdentityProvider}). Returns the verified claims, or
 * `undefined` for any failure: malformed token, unrecognized `alg`, unknown `kid`, bad signature,
 * wrong `aud`/`iss`, or expired. This function does not itself catch a throw (e.g. a `kid`-matched
 * JWK that `createPublicKey` rejects as malformed) — {@link cloudflareAccessIdentityProvider}'s
 * own try/catch is the one true backstop (design ii): every path here is a denial, but the
 * BACKSTOP, not this function, is what makes "never throw" true.
 */
function verifyCloudflareAccessAssertion(
  assertion: string,
  opts: CloudflareAccessOptions,
  now: () => number,
): CloudflareAccessClaims | undefined {
  const parts = assertion.split(".");
  if (parts.length !== 3) return undefined;
  const [headerB64, payloadB64, signatureB64] = parts;
  const header = decodeJwtSegment<{ kid?: string; alg?: string }>(headerB64);
  const nodeAlg = header.alg ? CLOUDFLARE_ACCESS_JWT_ALG_TO_NODE[header.alg] : undefined;
  if (!header.kid || !nodeAlg) return undefined;

  const keys = opts.keys.keys();
  const jwk = keys?.find((k) => k.kid === header.kid);
  if (!jwk) {
    // design (iii): a cache miss (empty cache, or no key matching this kid) denies THIS request
    // and schedules a refresh for the next one — never an inline fetch from inside `grant`.
    opts.keys.scheduleRefresh?.();
    return undefined;
  }

  const publicKey = createPublicKey({ key: jwk, format: "jwk" });
  const signedInput = Buffer.from(`${headerB64}.${payloadB64}`, "utf8");
  const signature = Buffer.from(signatureB64, "base64url");
  // THE load-bearing check: a forged assertion can carry any header/payload it likes (including
  // a `kid` that matches a real cached key) but cannot produce a signature that verifies against
  // that key's PUBLIC half without the matching private key Cloudflare alone holds.
  if (!verifySignature(nodeAlg, signedInput, publicKey, signature)) return undefined;

  const claims = decodeJwtSegment<CloudflareAccessClaims>(payloadB64);
  const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (!audiences.includes(opts.audience)) return undefined;
  if (claims.iss !== opts.teamDomain) return undefined;
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now()) return undefined;

  return claims;
}

/**
 * The Cloudflare Access grantor, wrapped as an {@link IdentityProvider} — W1-T430's seam, third
 * adopter. design (ii): THE WHOLE GRANT BODY IS WRAPPED — any failure, expected (malformed token,
 * unknown key, bad signature) or not (a key cache that itself throws), returns `undefined` rather
 * than propagating, because `grant` runs inside `createService`'s unawaited, uncaught
 * `void (async () => { ... })()` — an exception here does not deny the request, it kills the
 * process (rationale 4). design (vi): a verified assertion maps to a scope + write tier and
 * NOTHING else — no role/admin layer; {@link Scope} stays exactly `"read" | "write"`.
 */
export function cloudflareAccessIdentityProvider(opts: CloudflareAccessOptions): IdentityProvider {
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  return {
    name: "cloudflare-access",
    grant: (req) => {
      try {
        const header = req.headers["cf-access-jwt-assertion"];
        const assertion = Array.isArray(header) ? header[0] : header;
        if (!assertion) return undefined; // not my credential -- try the next provider.
        const claims = verifyCloudflareAccessAssertion(assertion, opts, now);
        return claims ? READ_WRITE : undefined;
      } catch (e) {
        // design (ii): NEVER throw. A validator that CAN throw (network failure, rotated key,
        // malformed key set) must still only ever deny, log, and fall through to the next
        // provider -- never propagate out of the fatal, uncaught IIFE that calls `grant`.
        log("service.access_jwt_error", { error: String((e as Error)?.message ?? e) });
        return undefined;
      }
    },
    // design (v), PROPOSED and argued on merits, not copied from either built-in grantor: the
    // identity here is strongly verified (a signed assertion, not a bearer secret a header could
    // forge) but reachable from ANY network, unlike `tailscaleIdentityProvider` (`high`, gated on
    // a private-network interface) -- and it is a real per-caller credential, unlike
    // `bearerTokenProvider` (`low`, one shared secret). `middle` reaches `/v1/control/stop` but
    // not the five HIGH-tier routes, which keep requiring the tailnet.
    writeTier: "middle",
  };
}

/**
 * design (iii): populates/refreshes a {@link CloudflareAccessKeyCache} from Cloudflare's own
 * certs endpoint (`{TEAM_DOMAIN}/cdn-cgi/access/certs`) entirely OFF the request path --
 * {@link cloudflareAccessIdentityProvider}'s `grant` only ever reads whatever `refresh()` last
 * wrote. A failed refresh (network error, non-200, malformed body) leaves the PREVIOUS keys in
 * place rather than clearing them: a transient outage denies nothing a moment-old cache still
 * recognizes, and an unknown `kid` stays a per-request denial either way, never a crash.
 * `scheduleRefresh` reentrancy-guards so a burst of cache misses fires at most one fetch at a
 * time, never a fetch storm. Not wired into `rmd serve` by this task (note: that wiring, plus the
 * Access application/tunnel/DNS ordering, are operator acts and separate tasks) -- exported so
 * that wiring has a ready-made default rather than reinventing one.
 */
export function createCloudflareAccessKeyCache(
  teamDomain: string,
  fetchImpl: typeof fetch = fetch,
  log: (step: string, extra?: Record<string, unknown>) => void = () => {},
): CloudflareAccessKeyCache & { refresh(): Promise<void> } {
  let cached: readonly CloudflareAccessJwk[] | undefined;
  let refreshing: Promise<void> | undefined;
  const refresh = async (): Promise<void> => {
    try {
      const res = await fetchImpl(`${teamDomain}/cdn-cgi/access/certs`);
      if (!res.ok) throw new Error(`certs endpoint returned ${res.status}`);
      const body = (await res.json()) as { keys?: CloudflareAccessJwk[] };
      if (!Array.isArray(body.keys)) throw new Error("certs response missing a keys array");
      cached = body.keys;
    } catch (e) {
      log("service.access_key_refresh_failed", { error: String((e as Error)?.message ?? e) });
      // deliberately no rethrow and no clearing of `cached` -- see this function's own doc.
    }
  };
  return {
    keys: () => cached,
    scheduleRefresh: () => {
      if (refreshing) return; // one in-flight fetch at a time -- never a fetch storm.
      refreshing = refresh().finally(() => {
        refreshing = undefined;
      });
    },
    refresh,
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
    if (scopes) return { scopes, provider: provider.name, tier: provider.writeTier, readSensitivity: provider.readSensitivity };
  }
  return undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/**
 * Error `code`s that mean THE CLIENT'S REQUEST WAS MALFORMED, not that this process is broken —
 * the discriminator {@link respondToRequestFailure} uses to answer 400 rather than 500.
 *
 * A SET rather than an `===` so the next shape code is admitted in one place, and deliberately
 * NARROW: membership is "Node raised this while parsing what the client sent", never "the message
 * looked client-ish". Anything unrecognised is a 500 with a `service.error` row, because grading an
 * unknown failure as the client's fault is exactly how a real defect hides behind a 4xx.
 *
 * `ERR_INVALID_URL` is the reproduced member: `new URL(req.url, "http://localhost")` in the
 * dispatch below throws it for a request line as short as `GET http://[ HTTP/1.1`, which Node's
 * HTTP parser accepts and hands through verbatim as `req.url`.
 */
const REQUEST_SHAPE_ERROR_CODES: ReadonlySet<string> = new Set(["ERR_INVALID_URL"]);

/**
 * The LAST RESORT for anything thrown out of `createService`'s dispatch — the backstop that makes
 * the unawaited `void (async () => { ... })()` below survivable.
 *
 * Before this, a throw anywhere outside the two inner `try` blocks (see
 * {@link cloudflareAccessIdentityProvider}'s design (ii), which defends itself precisely because
 * of this hazard) became an unhandled rejection and KILLED THE PROCESS: no `unhandledRejection`
 * handler existed anywhere in `src/` or `bin/`, so one malformed request line took down `rmd serve`
 * — console and webhook receiver both — and under launchd's 60 s restart throttle that is a
 * repeatable outage per packet, reachable from loopback, the tailnet or the relay.
 *
 * It logs `method`/`url` and NOT `path`, unlike every other row in this file: `path` is
 * `new URL(...).pathname`, and the commonest way to arrive here is that exact expression throwing,
 * so there is no parsed path to name. The raw request target is what the operator needs anyway.
 *
 * NEVER THROWS ITSELF, by construction — `log` is the caller's seam and could be anything, and a
 * throw here would land back in the unhandled rejection this function exists to prevent.
 */
function respondToRequestFailure(
  res: ServerResponse,
  log: NonNullable<ServiceOptions["log"]>,
  req: IncomingMessage,
  e: unknown,
): void {
  try {
    const method = (req.method ?? "GET").toUpperCase();
    const url = req.url ?? "/";
    const code = (e as { code?: unknown } | null | undefined)?.code;
    const clientFault = typeof code === "string" && REQUEST_SHAPE_ERROR_CODES.has(code);
    const error = String((e as Error)?.message ?? e);
    log(clientFault ? "service.bad_request" : "service.error", { method, url, error });
    if (!res.headersSent) {
      sendJson(res, clientFault ? 400 : 500, { error: clientFault ? "bad_request" : "internal_error" });
    }
    // Headers already out (an SSE stream that threw after `writeHead`, a handler that threw
    // mid-write): the status is no longer ours to choose, but leaving the client hanging on a
    // request this process has given up on is not an option either.
    if (!res.writableEnded) res.end();
  } catch {
    // See this function's own doc: it is the last resort, so it absorbs its own failures rather
    // than re-raising them into the rejection it was installed to catch.
  }
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
  // W1-T495: OFF by default — see ServiceOptions.enforceReadSensitivity's own doc for why
  // labeling a route's sensitivity must not, by itself, change what it accepts.
  const enforceReadSensitivity = opts.enforceReadSensitivity ?? false;
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
      // W1-T2568 (design i): a SELF-AUTHENTICATED route (see Route.selfAuthenticated's own doc)
      // skips the grantedScopes/tier/sensitivity dispatch below ENTIRELY — its handler is the
      // sole authenticator. Checked before any of that machinery runs, never after, so a
      // self-authenticated route's request is never rejected/logged as `service.unauthorized`
      // for lacking a bearer token it was never meant to carry.
      if (route?.selfAuthenticated) {
        try {
          await route.handler(req, res, { params: {} });
        } catch (e) {
          log("service.error", { method, path, error: String((e as Error)?.message ?? e) });
          if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
        }
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

      // W1-T495: the read-sensitivity gate, entirely additive to the scope check above and a
      // no-op unless BOTH `enforceReadSensitivity` is on AND this route declared a `sensitivity`
      // label — see ServiceOptions.enforceReadSensitivity's doc for why that is off by default.
      // An ORDINARY read grant (no `readSensitivity` reported, or a mismatched one) is refused
      // on a sensitive-labelled route and left untouched on every unlabelled one — the label
      // discriminates rather than merely existing (design v).
      if (enforceReadSensitivity && route?.sensitivity && granted.readSensitivity !== route.sensitivity) {
        log("service.forbidden_sensitivity", { method, path, required_sensitivity: route.sensitivity, granted_by: granted.provider });
        sendJson(res, 403, { error: "forbidden", required_scope: requiredScope, required_sensitivity: route.sensitivity });
        return;
      }

      // W1-T404: the tier + second-factor gate, entirely additive to the scope check above and
      // a no-op unless BOTH `enforceWriteTiers` is on AND this route declared a tier — see
      // ServiceOptions.enforceWriteTiers's doc. It is OFF by default in this library and ON in
      // `rmd serve`'s own wiring, so on the real console this branch is reached.
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
          // body. `enforceWriteTiers` off — this library's default, but NOT `rmd serve`'s, which
          // sets it true — never reaches this line at all; under the real console it is reached,
          // so a future HIGH-tier handler must honour the caveat above rather than assume it.
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
      // `.catch` and not a `try` wrapping the body: the body is an ASYNC function, so a
      // synchronous throw in it (`new URL` on the very first line) rejects this promise exactly
      // as an awaited failure would. Same coverage as the try, without reindenting the dispatch.
    })().catch((e: unknown) => {
      // NOT an erasure: every failure that lands here is logged and answered — see
      // {@link respondToRequestFailure}, which names the `error` it records and the status it
      // sends, and which absorbs nothing silently.
      respondToRequestFailure(res, log, req, e);
    });
  });
}
