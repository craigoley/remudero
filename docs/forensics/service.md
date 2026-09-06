# Forensics: src/lib/service.ts

Every measured fact, incident and design argument the comments in `src/lib/service.ts` used to
carry, archived VERBATIM when that file's comments were compacted to the plain-language standard
(`docs/comment-standard.md`).

Nothing here is a rule. The service surface's behaviour lives in the code, and each block below is
quoted exactly as it stood on `origin/main` at `79c73053`, under a heading naming the symbol it
explained. The code keeps a one-line `// Why:` pointer wherever that history still matters.

---

## module header

`src/lib/service.ts:1-44` at `79c73053`, 44 comment lines.

```
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
```

## WriteTier

`src/lib/service.ts:52-64` at `79c73053`, 13 comment lines.

```
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
```

## ReadSensitivity

`src/lib/service.ts:104-116` at `79c73053`, 13 comment lines.

```
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
```

## Route.allowQueryToken

`src/lib/service.ts:138-145` at `79c73053`, 8 comment lines.

```
  /**
   * If true, this route ALSO accepts the bearer credential via a `?token=` query param, not only
   * the `Authorization` header. Set this ONLY on the static HTML document (`GET /`): a browser
   * NAVIGATION cannot send an `Authorization` header, so the shell the operator opens by URL would
   * otherwise 401 and never load (the W1-T139 bootstrap paradox). NEVER set it on an API/data route
   * (`/v1/*`) — a token in the URL leaks via `Referer` and access logs; those stay header-only.
   */
```

## Route.tier

`src/lib/service.ts:146-156` at `79c73053`, 11 comment lines.

```
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
```

## Route.sensitivity

`src/lib/service.ts:158-169` at `79c73053`, 12 comment lines.

```
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
```

## Route.selfAuthenticated

`src/lib/service.ts:170-186` at `79c73053`, 17 comment lines.

```
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
```

## IdentityAuth

`src/lib/service.ts:210-247` at `79c73053`, 38 comment lines.

```
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
```

## IdentityProvider (the seam)

`src/lib/service.ts:259-270` at `79c73053`, 12 comment lines.

```
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
```

## IdentityProvider.grant

`src/lib/service.ts:276-286` at `79c73053`, 11 comment lines.

```
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
```

## IdentityProvider.writeTier

`src/lib/service.ts:288-296` at `79c73053`, 9 comment lines.

```
  /**
   * W1-T404: the {@link WriteTier} this provider's `write` grant is entitled to — a property of
   * the PROVIDER, not a per-request decision (mirrors `grant`'s own `read`/`write` set being one
   * fixed grant per grantor). `undefined` (the default for a provider that declares nothing)
   * satisfies no tier at all once {@link ServiceOptions.enforceWriteTiers} is on — silence is
   * never read as the lowest tier. Design (v)'s ruling for the bearer token specifically: an
   * EXISTING write credential resolves to `"low"`, a deliberate, visible break from a token that
   * used to reach every write route — see {@link bearerTokenProvider}.
   */
```

## IdentityProvider.readSensitivity

`src/lib/service.ts:297-305` at `79c73053`, 9 comment lines.

```
  /**
   * W1-T495: whether this provider's `read` grant is entitled to a {@link Route} labelled
   * `sensitivity: "sensitive"` — a property of the PROVIDER, not a per-request decision, mirroring
   * {@link writeTier}'s own shape. `undefined` (the default for a provider that declares nothing)
   * satisfies no sensitive-labelled route at all once {@link ServiceOptions.enforceReadSensitivity}
   * is on — silence is never read as an entitlement, the same rule {@link writeTier} states for
   * tiers.
   */
```

## ServiceOptions.enforceWriteTiers

`src/lib/service.ts:336-347` at `79c73053`, 12 comment lines.

```
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
```

## ServiceOptions.enforceReadSensitivity

`src/lib/service.ts:349-360` at `79c73053`, 12 comment lines.

```
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
```

## ConfirmNonceAction

`src/lib/service.ts:371-376` at `79c73053`, 6 comment lines.

```
/**
 * W1-T404 design (iv), ruled 2026-08-13, option (c): one action a {@link ConfirmNonceStore}
 * nonce is issued for or verified against — the EXACT route and payload it authorizes. Binding
 * to the action (not to a time window) is the reasoning the ruling itself records: it creates no
 * standing elevated state a stolen session can spend, and adds no second secret to paste.
 */
```

## CONFIRM_NONCE_TTL_MS

`src/lib/service.ts:402-415` at `79c73053`, 14 comment lines.

```
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
```

## createConfirmNonceStore, the issue() sweep

`src/lib/service.ts:434-441` at `79c73053`, 8 comment lines.

```
      // W1-T451 design (ii): EVICTION IS SEPARATE FROM EXPIRY. A TTL checked only on `consume`
      // fixes the security half (a stale nonce staying spendable) but leaves an unspent nonce in
      // the map forever, because it is never read again — unbounded growth needs its OWN
      // trigger. The daemon's existing sweeps (tmp_sweep, lock_sweep, orphan_sweep,
      // worker_home_sweep) run in the daemon process; this store lives in the serve process, so a
      // daemon tick can't reach it either. Sweep-on-issue is the one option that adds no new
      // clock/timer: amortised over calls to `issue`, bounded by call rate, and every issue call
      // already runs on this process's event loop.
```

## createConfirmNonceStore, the consume() TTL check

`src/lib/service.ts:456-463` at `79c73053`, 8 comment lines.

```
      // W1-T451 design (iii): does a TTL make the consume-on-mismatch burn better or worse for an
      // attacker who reaches the endpoint? BETTER dominates: it bounds how long a burned
      // confirmation could have been useful (an attacker who burns a nonce also can't wait out an
      // unbounded window and try later), and it doesn't create a materially cheaper denial —
      // burning a nonce is already immediate and free of a wait either way, since the operator's
      // next legitimate attempt needs a freshly issued nonce regardless of whether this one was
      // burned or simply expired. This is analysis only; the burn-on-any-mismatch behavior itself
      // is unchanged.
```

## makeConfirmNonceRoute

`src/lib/service.ts:489-500` at `79c73053`, 12 comment lines.

```
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
```

## RAW_BODY_CACHE

`src/lib/service.ts:530-544` at `79c73053`, 14 comment lines.

```
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
```

## readBoundedRawBody

`src/lib/service.ts:575-586` at `79c73053`, 12 comment lines.

```
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
```

## Cloudflare Access section header (the third IdentityProvider)

`src/lib/service.ts:717-727` at `79c73053`, 9 comment lines.

```
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
```

## CloudflareAccessKeyCache

`src/lib/service.ts:739-744` at `79c73053`, 6 comment lines.

```
/**
 * design (iii): the CACHED key set {@link cloudflareAccessIdentityProvider}'s `grant` reads
 * SYNCHRONOUSLY — `grant` cannot `await` a fetch (rationale 5), so whatever populates this cache
 * does so entirely out of band (see {@link createCloudflareAccessKeyCache}). `keys()` returning
 * `undefined`/empty, or returning a set with no matching `kid`, is a DENIAL for that request —
 * never an inline fetch, never a pinned certificate.
 */
```

## CloudflareAccessKeyCache.scheduleRefresh

`src/lib/service.ts:748-755` at `79c73053`, 6 comment lines.

```
  /**
   * Fire-and-forget: called when a request's `kid` isn't in the current cache, so an
   * implementation MAY schedule an out-of-band refresh for the NEXT request (design iii: "a
   * refresh scheduled out of band"). Never awaited by `grant` — a slow or failing refresh must
   * never affect the CURRENT request's synchronous denial. Optional: a cache refreshed purely on
   * its own timer can leave this a no-op.
   */
```

## verifyCloudflareAccessAssertion

`src/lib/service.ts:793-803` at `79c73053`, 9 comment lines.

```
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
```

## verifyCloudflareAccessAssertion, the cache-miss branch

`src/lib/service.ts:819-820` at `79c73053`, 2 comment lines.

```
    // design (iii): a cache miss (empty cache, or no key matching this kid) denies THIS request
    // and schedules a refresh for the next one — never an inline fetch from inside `grant`.
```

## cloudflareAccessIdentityProvider

`src/lib/service.ts:842-850` at `79c73053`, 9 comment lines.

```
/**
 * The Cloudflare Access grantor, wrapped as an {@link IdentityProvider} — W1-T430's seam, third
 * adopter. design (ii): THE WHOLE GRANT BODY IS WRAPPED — any failure, expected (malformed token,
 * unknown key, bad signature) or not (a key cache that itself throws), returns `undefined` rather
 * than propagating, because `grant` runs inside `createService`'s unawaited, uncaught
 * `void (async () => { ... })()` — an exception here does not deny the request, it kills the
 * process (rationale 4). design (vi): a verified assertion maps to a scope + write tier and
 * NOTHING else — no role/admin layer; {@link Scope} stays exactly `"read" | "write"`.
 */
```

## cloudflareAccessIdentityProvider, the catch branch

`src/lib/service.ts:863-866` at `79c73053`, 4 comment lines.

```
        // design (ii): NEVER throw. A validator that CAN throw (network failure, rotated key,
        // malformed key set) must still only ever deny, log, and fall through to the next
        // provider -- never propagate out of the fatal, uncaught IIFE that calls `grant`.
```

## createCloudflareAccessKeyCache

`src/lib/service.ts:881-892` at `79c73053`, 12 comment lines.

```
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
```

## grantedScopes

`src/lib/service.ts:924-933` at `79c73053`, 10 comment lines.

```
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
```

## REQUEST_SHAPE_ERROR_CODES

`src/lib/service.ts:951-964` at `79c73053`, 14 comment lines.

```
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
```

## respondToRequestFailure

`src/lib/service.ts:966-983` at `79c73053`, 18 comment lines.

```
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
```

## createService dispatch, the selfAuthenticated branch

`src/lib/service.ts:1068-1072` at `79c73053`, 5 comment lines.

```
      // W1-T2568 (design i): a SELF-AUTHENTICATED route (see Route.selfAuthenticated's own doc)
      // skips the grantedScopes/tier/sensitivity dispatch below ENTIRELY — its handler is the
      // sole authenticator. Checked before any of that machinery runs, never after, so a
      // self-authenticated route's request is never rejected/logged as `service.unauthorized`
      // for lacking a bearer token it was never meant to carry.
```

## createService dispatch, the read-sensitivity gate

`src/lib/service.ts:1100-1105` at `79c73053`, 6 comment lines.

```
      // W1-T495: the read-sensitivity gate, entirely additive to the scope check above and a
      // no-op unless BOTH `enforceReadSensitivity` is on AND this route declared a `sensitivity`
      // label. An ORDINARY read grant (no `readSensitivity` reported, or a mismatched one) is
      // refused on a sensitive-labelled route and left untouched on every unlabelled one — the
      // label discriminates rather than merely existing (design v).
```

## createService dispatch, the tier + second-factor gate

`src/lib/service.ts:1112-1115` at `79c73053`, 4 comment lines.

```
      // W1-T404: the tier + second-factor gate, entirely additive to the scope check above and
      // a no-op unless BOTH `enforceWriteTiers` is on AND this route declared a tier — see
      // ServiceOptions.enforceWriteTiers's doc. It is OFF by default in this library and ON in
      // `rmd serve`'s own wiring, so on the real console this branch is reached.
```

## createService dispatch, the nonce-consumption caveat

`src/lib/service.ts:1125-1132` at `79c73053`, 8 comment lines.

```
          // CONSUMPTION CAVEAT for a future HIGH-tier handler: presenting a nonce drains the
          // request body HERE to bind it to the exact bytes {@link makeConfirmNonceRoute} was
          // told to expect, so a handler reached past this point must not also read `req` as a
          // stream (a second `.on("data")` sees nothing — the body is already gone). Read
          // `ctx`/the already-parsed input instead, or accept this route never needs its own
          // body. `enforceWriteTiers` off — this library's default, but NOT `rmd serve`'s, which
          // sets it true — never reaches this line at all; under the real console it is reached,
          // so a future HIGH-tier handler must honour the caveat above rather than assume it.
```
