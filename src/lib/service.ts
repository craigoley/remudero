/**
 * lib/service.ts — the daemon's service surface v0 (W3-T1a, MASTER-PLAN §7A).
 *
 * INVARIANT: one HTTP server, one port, serves every REST route and SSE stream, bearer-scoped read
 * vs. write — no client gets a private backdoor (§7A). Generic mechanism only, pure and testable,
 * every side effect injected (mirrors lib/daemon.ts); concrete routes are `rmd serve`'s to wire.
 *
 * `write` implies `read`, compared constant-time (`timingSafeEqual`, never `===`, to avoid a
 * timing leak). 401 is "who are you", 403 is "I know you, you may not"; an unknown path is 404
 * regardless of auth. SSE is a subscribe/unsubscribe contract, not an event source — a caller's
 * `subscribe(send)` owns what streams. v0 routing is exact-match only (no params/wildcards).
 *
 * FALSIFIER: test/route-scope-matrix.test.ts, test/serve.test.ts.
 * Why: docs/forensics/service.md#module-header (W3-T1a, W3-T1b, W3-T1c).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createPublicKey, randomBytes, timingSafeEqual, verify as verifySignature } from "node:crypto";
import { join as joinPath, resolve as resolvePath, sep } from "node:path";

/** Bearer scope a route (or SSE stream) requires. `write` implies `read`. */
export type Scope = "read" | "write";

/**
 * A write-scoped route's CONSEQUENCE class (W1-T404, MASTER-PLAN §7A/§7): `low` is trivially
 * reversible bookkeeping, `middle` reversible-but-disruptive (or a force multiplier for `high`),
 * `high` spends money or moves code. PURELY DECLARATIVE on {@link Route} — see {@link writeTierSatisfies}.
 * Why: docs/forensics/service.md#writetier (W1-T404).
 */
export type WriteTier = "low" | "middle" | "high";

const WRITE_TIER_RANK: Record<WriteTier, number> = { low: 1, middle: 2, high: 3 };

/** True iff a `granted` write tier meets a `required` one — higher tiers imply lower ones,
 *  mirroring `write`→`read` in {@link Scope}. `undefined` is never read as the lowest tier. */
export function writeTierSatisfies(granted: WriteTier | undefined, required: WriteTier): boolean {
  if (!granted) return false;
  return WRITE_TIER_RANK[granted] >= WRITE_TIER_RANK[required];
}

/** Every write-scoped route in `routes` with no declared {@link Route.tier} (design iii) — the
 *  completeness check against the REAL assembled table. Empty ⇒ every write route is classified. */
export function writeRoutesMissingTier(routes: readonly Route[]): string[] {
  return routes.filter((r) => r.scope === "write" && !r.tier).map((r) => `${r.method} ${r.path}`);
}

/** Runs {@link writeRoutesMissingTier} and THROWS on a non-empty result rather than merely
 *  reporting — the stronger, "runs inside the product function" form design (iii-a) calls for. */
export function assertWriteTiersComplete(routes: readonly Route[]): void {
  const missing = writeRoutesMissingTier(routes);
  if (missing.length > 0) {
    throw new Error(`write-scoped route(s) with no declared WriteTier: ${missing.join(", ")}`);
  }
}

/**
 * A read route's sensitivity label (W1-T495, MASTER-PLAN §7A) — the read-side axis to {@link
 * WriteTier}'s write-side one, a single label rather than a rank. Absence means "ordinary read",
 * enforced once {@link ServiceOptions.enforceReadSensitivity} is on.
 * Why: docs/forensics/service.md#readsensitivity (W1-T495).
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
  /** Also accepts the bearer credential via `?token=`. Set ONLY on the static HTML document
   *  (`GET /`) — a browser navigation can't send an `Authorization` header (W1-T139 bootstrap
   *  paradox). NEVER on an API/data route: a token in the URL leaks via `Referer` and logs. */
  allowQueryToken?: boolean;
  /** This route's {@link WriteTier} (W1-T404) — DECLARED, never derived. Meaningful only when
   *  `scope === "write"`; every write route must carry one (see {@link writeRoutesMissingTier}).
   *  Enforced only once {@link ServiceOptions.enforceWriteTiers} is on. */
  tier?: WriteTier;
  /** This READ route's {@link ReadSensitivity} label (W1-T495) — DECLARED, never derived, mirrors
   *  {@link tier}. Meaningful only when `scope === "read"`; enforced once
   *  {@link ServiceOptions.enforceReadSensitivity} is on. Labelling the real table is separate work. */
  sensitivity?: ReadSensitivity;
  /** Marks this route SELF-AUTHENTICATED (W1-T2568): its handler verifies the caller itself (HMAC
   *  over the raw body, e.g. GitHub's) rather than the bearer/{@link IdentityProvider} seam, which
   *  needs a synchronous, request-only `grant`. Bypasses scope/tier/sensitivity dispatch entirely —
   *  the handler alone must verify first, fail closed, and use {@link readBoundedRawBody}. */
  selfAuthenticated?: boolean;
}

/** Push one SSE event to a subscribed client (`event:`/`data:` framing, owned by this module). */
export type SseSend = (event: string, data: unknown) => void;

/** One SSE stream: an exact GET `path` match gated by `scope`. */
export interface SseRoute {
  path: string;
  scope: Scope;
  /** Called once per client connection, after the scope check passes. Must return an
   *  unsubscribe/cleanup function, invoked on disconnect — no subscription outlives the client. */
  subscribe: (send: SseSend) => () => void;
}

/** The two bearer tokens this surface accepts. `write` also satisfies `read`-scoped routes. */
export interface ServiceTokens {
  read: string;
  write: string;
}

/**
 * Tailnet-identity auth, ADDITIVE to the bearer tokens above (W1-T371, MASTER-PLAN §7's
 * auth-endgame): consulted first but only ever ADDS a grant, so a Tailscale failure falls through
 * to the token unchanged rather than locking the operator out.
 *
 * Two gates, both required: INTERFACE (`trustedLocalAddress`, the only bound address Serve's
 * identity headers are trusted on) and ALLOWLIST (`capability`, a Tailscale ACL app-capability
 * evaluated per NODE, not per account). Funnel traffic carries neither header, so it fails closed.
 *
 * FALSIFIER: test/tailnet-identity-scope.test.ts.
 * Why: docs/forensics/service.md#identityauth (W1-T371, Tailscale Serve identity-headers guidance).
 */
export interface IdentityAuth {
  /** Local address (`req.socket.localAddress`) identity headers are honored on. Production
   *  wiring passes the loopback address Tailscale Serve's target binds; a request elsewhere
   *  never consults `capability` below, forged header or not. */
  trustedLocalAddress: string;
  /** The Tailscale ACL app-capability name an allowlisted node/user must be granted — see this interface's own doc. */
  capability: string;
}

/** The auth/identity extension seam (W1-T430, MASTER-PLAN §6A) — replaces two scope-granting
 *  paths inlined into {@link grantedScopes} with a declared interface. {@link createService}
 *  wires identity first (additive) then the token fallback, appending `ServiceOptions.providers`. */
export interface IdentityProvider {
  /** Provenance label carried through to {@link IdentityGrant.provider} — distinguishes "nobody
   *  vouched" (401) from "vouched, but underscoped" (403) in {@link createService}'s dispatch. */
  readonly name: string;
  /** Given the request (and whether `?token=` fallback applies, true only for the HTML shell),
   *  return the granted scopes, or `undefined` if unrecognized — not a denial, "try the next
   *  provider"; only once every provider answers `undefined` does the request fail closed (401). */
  grant(req: IncomingMessage, allowQueryToken: boolean): ReadonlySet<Scope> | undefined;
  /** The {@link WriteTier} this provider's `write` grant is entitled to (W1-T404) — a PROVIDER
   *  property, not per-request. `undefined` satisfies no tier once
   *  {@link ServiceOptions.enforceWriteTiers} is on (see {@link bearerTokenProvider}: `"low"`). */
  readonly writeTier?: WriteTier;
  /** Whether this provider's `read` grant is entitled to a `sensitivity: "sensitive"` {@link Route}
   *  (W1-T495) — mirrors {@link writeTier}; `undefined` satisfies no sensitive route once
   *  {@link ServiceOptions.enforceReadSensitivity} is on. */
  readonly readSensitivity?: ReadSensitivity;
}

/** What {@link createService}'s provider dispatch hands back once some {@link IdentityProvider}
 * recognizes a request: the scopes granted, plus which provider granted them. */
export interface IdentityGrant {
  scopes: ReadonlySet<Scope>;
  provider: string;
  /** The granting provider's {@link IdentityProvider.writeTier}, carried through unchanged (W1-T404). */
  tier?: WriteTier;
  /** The granting provider's {@link IdentityProvider.readSensitivity}, carried through unchanged (W1-T495). */
  readSensitivity?: ReadSensitivity;
}

/**
 * W1-T3175 — A STATIC MOUNT FOR THE BUILT CONSOLE, here and not in `serve.ts` because this module's
 * routing is EXACT-MATCH ONLY and a built SPA is content-hashed filenames under a prefix. `serve.ts`
 * hands its routes to {@link createService} and never wraps the handler, so an asset route that must
 * enforce the SAME read scope as the shell has to sit INSIDE that dispatch. It SYNTHESISES A ROUTE
 * AND NOTHING ELSE: a way to FIND a handler, never a second way to authorise one.
 */
export interface StaticMount {
  /** URL prefix every asset sits under, e.g. `/console/`. Exact routes always win over this. */
  prefix: string;
  /** The RESOLVED build directory. Nothing outside it is ever served. */
  root: string;
  /** The scope an asset requires — the shell's own, so no asset is readable by a caller who could
   *  not load the console. */
  scope: Scope;
  /** Client-routed paths that return the shell. EXPLICIT, NEVER A CATCH-ALL: a fallback that
   *  answers everything turns a missing build artifact into a blank page with a syntax error. */
  clientRoutes?: readonly string[];
  /** Injected filesystem, so every decision below is provable without a real tree. */
  io: StaticMountIo;
}

export interface StaticMountIo {
  /** The path a symlink chain really lands on, or `null` when it does not exist. */
  realpath: (p: string) => string | null;
  readFile: (p: string) => Buffer;
}

/** CONTENT TYPE FROM A CLOSED ALLOW-LIST. An unknown extension is REFUSED, never served as
 *  octet-stream: a console build emits a known, small set of kinds, and anything else is a surprise. */
export const STATIC_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** Why a request under the mount was not served. Returned so the caller can LOG it while still
 *  answering 404 — a refusal that says nothing is indistinguishable from a missing file. */
export type StaticRefusal = "escapes_root" | "unknown_extension" | "absent";

export type StaticResolution =
  | { kind: "asset"; file: string; contentType: string }
  | { kind: "shell"; file: string; contentType: string }
  | { kind: "refused"; reason: StaticRefusal };

/**
 * What a path under the mount resolves to. PURE apart from the injected io.
 *
 * THE CONTAINMENT CHECK IS ON THE REALPATH, not the requested string: refusing `..` textually misses
 * a URL-encoded separator (it decodes AFTER any string check) and a symlink inside the root whose
 * target is outside it.
 */
export function resolveStaticRequest(mount: StaticMount, path: string): StaticResolution | null {
  if (!path.startsWith(mount.prefix)) return null;

  // A DECLARED client route returns the shell. Checked before the file lookup so a client path can
  // never be shadowed by a same-named file, and so an UNDECLARED path falls through to `absent`.
  if ((mount.clientRoutes ?? []).includes(path)) {
    const shell = joinPath(mount.root, "index.html");
    return mount.io.realpath(shell) === null
      ? { kind: "refused", reason: "absent" }
      : { kind: "shell", file: shell, contentType: STATIC_CONTENT_TYPES[".html"] };
  }

  let rest: string;
  try {
    rest = decodeURIComponent(path.slice(mount.prefix.length));
  } catch {
    return { kind: "refused", reason: "escapes_root" }; // a malformed escape is not a filename
  }
  if (rest === "" || rest.endsWith("/")) rest = `${rest}index.html`;

  const candidate = resolvePath(mount.root, rest);
  const real = mount.io.realpath(candidate);
  if (real === null) return { kind: "refused", reason: "absent" };
  if (real !== mount.root && !real.startsWith(mount.root + sep)) {
    return { kind: "refused", reason: "escapes_root" };
  }

  const dot = real.lastIndexOf(".");
  const ext = dot === -1 ? "" : real.slice(dot).toLowerCase();
  const contentType = STATIC_CONTENT_TYPES[ext];
  if (!contentType) return { kind: "refused", reason: "unknown_extension" };

  return { kind: "asset", file: real, contentType };
}

export interface ServiceOptions {
  tokens: ServiceTokens;
  /** Additive tailnet-identity auth — see {@link IdentityAuth}. Omitted: identity is never consulted, byte-for-byte the pre-W1-T371 behavior. */
  identity?: IdentityAuth;
  /** Additional {@link IdentityProvider}s consulted after the two built-in grantors (W1-T430's
   *  seam) — attaches a future grantor without editing this module's dispatch. Empty by default. */
  providers?: IdentityProvider[];
  routes?: Route[];
  sse?: SseRoute[];
  /** W1-T3175 — the built console. Omitted: this module behaves byte-for-byte as before. */
  staticMount?: StaticMount;
  /** One ledger line per auth decision / SSE lifecycle event / handler error. */
  log?: (step: string, extra?: Record<string, unknown>) => void;
  /** Turns ON tier + second-factor enforcement (W1-T404) — OFF by default here, so labeling a
   *  tier never changes access until set. `rmd serve` sets `true` (W1-T500), with
   *  {@link makeConfirmNonceRoute} mounted for HIGH-tier confirmation.
   *  Why: docs/forensics/service.md#enforcewritetiers (W1-T404, W1-T500). */
  enforceWriteTiers?: boolean;
  /** Turns ON sensitivity enforcement (W1-T495) — OFF by default, {@link enforceWriteTiers}'s
   *  precedent. Ships dark: no built-in provider or production route declares one yet.
   *  Why: docs/forensics/service.md#enforcereadsensitivity (W1-T495). */
  enforceReadSensitivity?: boolean;
  /** The nonce store HIGH-tier routes consult when {@link enforceWriteTiers} is on (W1-T404,
   *  design iv). Defaults to a fresh {@link createConfirmNonceStore} — one process, no sharing. */
  confirmNonces?: ConfirmNonceStore;
}

/** One action a {@link ConfirmNonceStore} nonce authorizes — the exact route and payload
 *  (W1-T404, design iv). Binding to the action, not a time window, avoids standing elevated state. */
export interface ConfirmNonceAction {
  method: Method;
  path: string;
  /** The raw request body text the authorized call sends, byte for byte — never a re-serialized
   *  parsed object, which could reorder/drop keys the caller never typed. */
  payload: string;
}

/** Server-issued, single-use, action-and-payload-bound second factor. `issue` proves nothing by
 *  itself; `consume` verifies AND SPENDS in one step, so a captured nonce can never be replayed. */
export interface ConfirmNonceStore {
  issue(action: ConfirmNonceAction): string;
  consume(nonce: string, action: ConfirmNonceAction): boolean;
  /** Count of entries not yet consumed or swept (W1-T451). Exists ONLY so a test can observe that
   *  eviction actually bounds growth. `createService`'s dispatch never reads this. */
  size(): number;
}

/** The nonce's TTL (W1-T451, design i): covers one round trip — issue, an operator reads the
 *  confirmation, spend. Five minutes sits roughly two orders of magnitude past the tens-of-seconds
 *  a careful read takes, while staying bounded rather than reinstating a standing elevated state.
 *  Why: docs/forensics/service.md#confirm_nonce_ttl_ms (W1-T451). */
export const CONFIRM_NONCE_TTL_MS = 5 * 60 * 1000;

interface StoredConfirmNonce {
  action: ConfirmNonceAction;
  issuedAt: number;
}

/** In-memory default — single process, no persistence needed. `randomToken`/`now` are injectable
 *  so a test can assert on a known nonce or expiry without sleeping; production uses the reals. */
export function createConfirmNonceStore(
  randomToken: () => string = () => randomBytes(24).toString("hex"),
  now: () => number = () => Date.now(),
): ConfirmNonceStore {
  const pending = new Map<string, StoredConfirmNonce>();
  return {
    issue(action) {
      // Eviction is separate from expiry, swept here amortised over calls (W1-T451, design ii).
      // Why: docs/forensics/service.md#createconfirmnoncestore-issue.
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
      // A TTL check here also bounds a burned confirmation's usefulness to an attacker.
      // Why: docs/forensics/service.md#createconfirmnoncestore-consume (W1-T451, design iii).
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
 * `POST /v1/confirm` (design iv): names the exact `{method, path, payload}` a HIGH-tier call
 * will make and returns a nonce that call must present (`X-Confirm-Nonce`). Plain write scope —
 * requesting a nonce grants nothing; the target route's own tier + nonce check is the real gate.
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
 * The raw body, MEMOISED ON THE REQUEST (W1-T500): a stream reads once, and the HIGH-tier nonce
 * check is the FIRST reader, so every HIGH-tier handler downstream needs the cached bytes, not
 * an ended stream. `Symbol.for` keyed so panel-actions.ts's `readJsonBody`, sharing no import,
 * resolves the same cache.
 * Why: docs/forensics/service.md#raw_body_cache (W1-T500).
 */
export const RAW_BODY_CACHE = Symbol.for("remudero.service.rawBody");

/** Read + buffer a body verbatim, never JSON-parsed — the ONE primitive both
 *  {@link makeConfirmNonceRoute} and createService's dispatch bind a nonce's `payload` against.
 *  Rejects (never throws synchronously) on a socket error. */
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

/** Thrown by {@link readBoundedRawBody} on an over-bound body (W1-T2568); later bytes are
 *  drained but never buffered, so the caller gets the route's 413 instead of a connection reset. */
export class RawBodyTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`request body exceeds the ${maxBytes}-byte bound`);
    this.name = "RawBodyTooLargeError";
  }
}

/**
 * The self-authenticated/raw-body seam's other half (W1-T2568): reads + buffers a body exactly
 * like {@link readRawBody} (same {@link RAW_BODY_CACHE} symbol), but BOUNDED — a body over
 * `maxBytes` rejects with {@link RawBodyTooLargeError} and drains later chunks unretained.
 * Exported for any `selfAuthenticated` handler; github-event-wake.ts's webhook is the first caller.
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
  // timingSafeEqual throws on a length mismatch, so length is checked (cheaply) first.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer (.+)$/.exec(header);
  return match?.[1];
}

/** The `?token=` query-param credential, read ONLY for a route with `allowQueryToken` (the HTML
 *  shell, reached by a browser navigation with no `Authorization` header). Never honored on an
 *  API/data route — it would leak via `Referer` and logs. */
function queryToken(req: IncomingMessage): string | undefined {
  const raw = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
  return raw && raw.length > 0 ? raw : undefined;
}

/** Scopes granted by tailnet identity — {@link IdentityAuth}'s two gates, both required.
 *  `undefined` on either failure falls through to the bearer token (additive, never a replacement). */
function identityGrantedScopes(identity: IdentityAuth | undefined, req: IncomingMessage): ReadonlySet<Scope> | undefined {
  if (!identity) return undefined;
  // Gate 1 INTERFACE: a header on any other bound address is untrusted, forged or not.
  if (req.socket.localAddress !== identity.trustedLocalAddress) return undefined;
  // Gate 2 ALLOWLIST: an unlisted node has no entry for `identity.capability` in this header.
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

/** {@link IdentityAuth}'s tailnet-identity grantor, wrapped as an {@link IdentityProvider}
 *  (W1-T430's seam, adopter #1); `allowQueryToken` is irrelevant here, so ignored. */
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

/** The bearer-token grantor (`ServiceTokens`, constant-time compare) wrapped as an
 * {@link IdentityProvider} — W1-T430's seam, adopter #2. `?token=` is honored only when the
 * caller passes `allowQueryToken` (true only for the HTML shell route). */
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

/** The third {@link IdentityProvider} (W1-T531, MASTER-PLAN §6A). Cloudflare Access puts a
 *  verified identity in front of a request (`Cf-Access-Jwt-Assertion`) — its mere presence
 *  doesn't prove it; signature, audience, issuer and expiry are all verified against Cloudflare's keys. */

/** One JSON Web Key as Cloudflare's certs endpoint returns it — the shape
 *  `crypto.createPublicKey({ format: "jwk", key })` accepts, so no JWT library is needed. */
export interface CloudflareAccessJwk {
  kid: string;
  kty: string;
  [field: string]: unknown;
}

/**
 * The cached key set `grant` reads SYNCHRONOUSLY (design iii) — it can't `await` a fetch, so this
 * cache is populated out of band (see {@link createCloudflareAccessKeyCache}). An empty cache or
 * no matching `kid` is a DENIAL, never an inline fetch or a pinned cert.
 */
export interface CloudflareAccessKeyCache {
  /** Current JWKS keys, or `undefined` before the first successful fetch. */
  keys(): readonly CloudflareAccessJwk[] | undefined;
  /**
   * Fire-and-forget: called on a cache miss so an implementation MAY schedule a refresh for the
   * NEXT request. Never awaited by `grant` — a slow refresh must never affect the current denial.
   */
  scheduleRefresh?(): void;
}

/** Configuration for {@link cloudflareAccessIdentityProvider}. */
export interface CloudflareAccessOptions {
  /** The operator's Cloudflare Access team domain — checked against the JWT's `iss` claim, and
   *  used by {@link createCloudflareAccessKeyCache} to build the certs endpoint URL. */
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
 * Every claim checked (design iv) — signature against the cached keys, `aud`, `iss`, and expiry.
 * Header PRESENCE is deliberately not one of them; this only runs once the header is known
 * present. Returns the verified claims or `undefined` for any failure. Does not itself catch a
 * throw — {@link cloudflareAccessIdentityProvider}'s try/catch is the one true backstop.
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
    // A cache miss denies THIS request and schedules a refresh for the next one (design iii).
    opts.keys.scheduleRefresh?.();
    return undefined;
  }

  const publicKey = createPublicKey({ key: jwk, format: "jwk" });
  const signedInput = Buffer.from(`${headerB64}.${payloadB64}`, "utf8");
  const signature = Buffer.from(signatureB64, "base64url");
  // THE load-bearing check: a forged assertion can carry any header/payload but cannot produce a
  // signature verifying against the key's PUBLIC half without Cloudflare's private key.
  if (!verifySignature(nodeAlg, signedInput, publicKey, signature)) return undefined;

  const claims = decodeJwtSegment<CloudflareAccessClaims>(payloadB64);
  const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (!audiences.includes(opts.audience)) return undefined;
  if (claims.iss !== opts.teamDomain) return undefined;
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now()) return undefined;

  return claims;
}

/**
 * The Cloudflare Access grantor (W1-T430's seam, third adopter). The whole grant body is wrapped
 * (design ii): any failure returns `undefined` rather than propagating, since `grant` runs inside
 * `createService`'s unawaited, uncaught IIFE. A verified assertion maps to a scope + write tier
 * and nothing else (design vi) — no role/admin layer.
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
        // NEVER throw (design ii) — deny, log, and fall through to the next provider instead.
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
 * Populates/refreshes a {@link CloudflareAccessKeyCache} off the request path (design iii). A
 * failed refresh keeps the PREVIOUS keys, so a transient outage denies nothing a moment-old cache
 * still recognizes; `scheduleRefresh` reentrancy-guards to one fetch at a time.
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
 * Dispatch across `providers` IN ORDER, returning the first grant (plus provenance) or
 * `undefined` if none recognize the credentials (401) — tailnet identity first but additive, the
 * bearer token the fallback, then any appended `providers`. This loop is the ENTIRE gate (W1-T430).
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
 * Error `code`s meaning the CLIENT's request was malformed, not that this process is broken —
 * {@link respondToRequestFailure}'s 400-vs-500 discriminator. Deliberately NARROW: unrecognised
 * codes are a 500. `ERR_INVALID_URL` is the reproduced member — `new URL(req.url, ...)` throws it
 * for a request line as short as `GET http://[ HTTP/1.1`, which Node's parser lets through.
 */
const REQUEST_SHAPE_ERROR_CODES: ReadonlySet<string> = new Set(["ERR_INVALID_URL"]);

/**
 * The LAST RESORT for anything thrown out of dispatch — makes the unawaited IIFE below
 * survivable. TRAP: before this, a throw outside the inner `try` blocks became an unhandled
 * rejection and KILLED THE PROCESS — one malformed request line took down `rmd serve` entirely.
 * NEVER THROWS ITSELF, by construction.
 * FALSIFIER: test/serve-survives-malformed-url.test.ts.
 * Why: docs/forensics/service.md#respondtorequestfailure (R-2).
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
    // Headers already out: the status is no longer ours to choose, but the client must not be
    // left hanging on a request this process has given up on.
    if (!res.writableEnded) res.end();
  } catch {
    // Last resort: absorb rather than re-raise into the rejection this exists to catch.
  }
}

function openSse(req: IncomingMessage, res: ServerResponse, route: SseRoute, path: string, log: NonNullable<ServiceOptions["log"]>): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  // Prime the stream immediately so the client sees an open 200 before subscribe()'s first event.
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

/** Build (but do not start) the daemon's single-port service surface — the caller owns
 *  `.listen(port)`/`.close()`. No side effect this module didn't get injected (mirrors
 *  lib/daemon.ts). */
export function createService(opts: ServiceOptions): Server {
  const routes = opts.routes ?? [];
  const sseRoutes = opts.sse ?? [];
  const log = opts.log ?? (() => {});
  // Identity first (additive), then the bearer token — the pre-seam order, then extra providers.
  const providers: IdentityProvider[] = [
    ...(opts.identity ? [tailscaleIdentityProvider(opts.identity)] : []),
    bearerTokenProvider(opts.tokens),
    ...(opts.providers ?? []),
  ];
  // OFF by default (W1-T404) — labeling a tier alone must not change what a route accepts.
  const enforceWriteTiers = opts.enforceWriteTiers ?? false;
  // OFF by default (W1-T495) — labeling sensitivity alone must not change what a route accepts.
  const enforceReadSensitivity = opts.enforceReadSensitivity ?? false;
  const confirmNonces = opts.confirmNonces ?? createConfirmNonceStore();
  const staticMount = opts.staticMount;

  return createServer((req, res) => {
    void (async () => {
      const method = (req.method ?? "GET").toUpperCase() as Method;
      const path = new URL(req.url ?? "/", "http://localhost").pathname;

      const sseRoute = method === "GET" ? sseRoutes.find((r) => r.path === path) : undefined;
      let route = sseRoute ? undefined : routes.find((r) => r.method === method && r.path === path);

      // W1-T3175 — CONSULTED LAST, only when no declared route matched, so it can never shadow an
      // API route. Auth, scope, logging and error handling below all run unchanged.
      if (!sseRoute && !route && staticMount && method === "GET") {
        const resolved = resolveStaticRequest(staticMount, path);
        if (resolved && resolved.kind === "refused") {
          // 404 TO THE CALLER, THE REASON TO THE LEDGER: a refusal that tells the operator nothing
          // is indistinguishable from a missing file.
          log("service.static_refused", { path, reason: resolved.reason });
        } else if (resolved) {
          route = {
            method: "GET",
            path,
            scope: staticMount.scope,
            handler: (_rq, rs) => {
              rs.writeHead(200, { "content-type": resolved.contentType });
              rs.end(staticMount.io.readFile(resolved.file));
            },
          };
        }
      }

      if (!sseRoute && !route) {
        sendJson(res, 404, { error: "not_found" });
        return;
      }
      // A SELF-AUTHENTICATED route (Route.selfAuthenticated) skips scope/tier/sensitivity
      // dispatch ENTIRELY; checked first, so it's never logged `service.unauthorized` for
      // lacking a bearer token it was never meant to carry.
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

      // The read-sensitivity gate (W1-T495), additive to the scope check above, a no-op unless
      // BOTH `enforceReadSensitivity` is on AND the route declared `sensitivity` — an ordinary
      // read grant is refused there and untouched on every unlabelled route.
      if (enforceReadSensitivity && route?.sensitivity && granted.readSensitivity !== route.sensitivity) {
        log("service.forbidden_sensitivity", { method, path, required_sensitivity: route.sensitivity, granted_by: granted.provider });
        sendJson(res, 403, { error: "forbidden", required_scope: requiredScope, required_sensitivity: route.sensitivity });
        return;
      }

      // The tier + second-factor gate (W1-T404), additive to the scope check above, a no-op
      // unless BOTH `enforceWriteTiers` is on AND the route declared a tier — OFF by default
      // here, ON in `rmd serve`'s own wiring.
      if (enforceWriteTiers && route?.tier) {
        if (!writeTierSatisfies(granted.tier, route.tier)) {
          log("service.forbidden_tier", { method, path, required_tier: route.tier, granted_by: granted.provider, granted_tier: granted.tier });
          sendJson(res, 403, { error: "forbidden", required_scope: requiredScope, required_tier: route.tier });
          return;
        }
        if (route.tier === "high") {
          const nonceHeader = req.headers["x-confirm-nonce"];
          const nonce = Array.isArray(nonceHeader) ? nonceHeader[0] : nonceHeader;
          // CAVEAT: presenting a nonce drains the request body HERE to bind it to the exact
          // bytes makeConfirmNonceRoute expects, so a handler reached past this point must read
          // the already-parsed input instead of `req` as a stream.
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
      // `.catch`, not a wrapping `try`: the body is an ASYNC function, so a synchronous throw in
      // it rejects this promise exactly as an awaited failure would.
    })().catch((e: unknown) => {
      // NOT an erasure — every failure here is logged and answered by
      // {@link respondToRequestFailure}, which absorbs nothing silently.
      respondToRequestFailure(res, log, req, e);
    });
  });
}
