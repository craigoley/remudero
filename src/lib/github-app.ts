/**
 * The fleet authenticates as the installed GitHub App (W1-T1024, MASTER-PLAN §9), so its own
 * `core`/`graphql` rate-limit buckets are separate from an operator's interactive session.
 *
 * Invariant: `process.env.GH_TOKEN` is the one seam this module writes — `env.ts`'s worker
 * allowlist, `review.ts`'s spawn env, and `entrypoint.sh`'s credential helper all read it at call
 * time, so refreshing it here reaches every consumer with no call-site change (see
 * {@link refreshInstallationToken}). Every failure leaves it untouched; nothing here refuses to
 * boot. No secret — the private key or the minted token — ever reaches a log line or a ledger
 * row; only the installation id, the token's `expires_at`, and a fixed reason string do.
 *
 * A run child owns a separate refresh loop; model workers still inherit a snapshot at spawn.
 */
// Why: docs/forensics/github-app.md#module-header

// ── W1-T2311 DECISION RECORD: THE BOOT ENV CARRIED THE PAT, NOT THIS MODULE ─────────────────────
// A recycle forwarded a personal GH_TOKEN this per-process refresh could never displace (forensics).
// REMEDY (a) TAKEN: the boot env carries no GH_TOKEN (deploy/recycle-container.sh). REMEDY (b),
// refusing on a failed exchange, was NOT taken: it would break W1-T1068's degrade-never-refuse loop.
// A timed-out exchange still leaves the previous value untouched. The one-in-three timeouts, long
// UNINVESTIGATED, were the daemon's own stalled loop (2026-10-15); see exchangeDeadline.
// Why: docs/forensics/github-app.md#the-w1-t2311-decision-record

import { readFileSync } from "node:fs";
import { sign as cryptoSign } from "node:crypto";
import { clockFromMillisFn, fixedClock, type Clock } from "./clock.js";

/** Env var names, not values — mirrors `GH_TOKEN`'s own shape. `GH_APP_PRIVATE_KEY_PATH_ENV`
 *  names a path to the mounted key file, never the key material itself. */
export const GH_APP_ID_ENV = "GH_APP_ID";
export const GH_APP_INSTALLATION_ID_ENV = "GH_APP_INSTALLATION_ID";
export const GH_APP_PRIVATE_KEY_PATH_ENV = "GH_APP_PRIVATE_KEY_PATH";

/** GitHub's own contract: an installation access token is valid for exactly one hour. */
export const INSTALLATION_TOKEN_LIFETIME_MS = 60 * 60 * 1000;

/** Twenty minutes leaves room for the observed renewal delay on 2026-09-28 and several
 *  bounded exchanges before the one-hour token expires. */
export const REFRESH_MARGIN_MS = 20 * 60 * 1000;

/** Retry a failed exchange independently of the earlier healthy refresh margin. */
export const REFRESH_FAILURE_RETRY_MS = 2 * 60 * 1000;

/** Slack so a failure retry is not scheduled exactly at the last bounded-exchange millisecond. */
const REFRESH_FAILURE_RETRY_GUARD_MS = 1000;

// GitHub's App-JWT contract: `iat` is backdated for clock skew and `exp` is capped at ten
// minutes. This JWT mints one installation token and is then discarded, so nine minutes of life
// stays under that ceiling with margin.
const JWT_BACKDATE_SEC = 60;
const JWT_TTL_SEC = 9 * 60;

/** `fetch` has no default timeout, so a hung exchange would stall the refresh loop forever; 20 s of
 *  loop-available time (exchangeDeadline) is a reasoned bound, not a fit (forensics). Exported for tests. */
// Why: docs/forensics/github-app.md#exchange_timeout_ms
export const EXCHANGE_TIMEOUT_MS = 20 * 1000;

/** The two ledger step names this module writes, owned here so each has exactly one spelling —
 *  imported by readers like `deriveNeedsMe` (`src/lib/status-board.ts`) rather than retyped. */
// Why: docs/forensics/github-app.md#token_refreshed_step
export const TOKEN_REFRESHED_STEP = "github_app.token_refreshed";
/** @see TOKEN_REFRESHED_STEP */
export const TOKEN_REFRESH_FAILED_STEP = "github_app.token_refresh_failed";

export interface RefreshOptions {
  /** Overrides `GH_APP_ID_ENV` — test seam only. */
  appId?: string;
  /** Overrides `GH_APP_INSTALLATION_ID_ENV` — test seam only. */
  installationId?: string;
  /** Overrides `GH_APP_PRIVATE_KEY_PATH_ENV` — test seam only. */
  privateKeyPath?: string;
  /** Defaults to `process.env`, the object every consumer reads (see the file header). */
  env?: NodeJS.ProcessEnv;
  /** Injectable clock — defaults to `Date.now`. */
  now?: () => number;
  /** Injectable fetch — defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable private-key reader — defaults to `readFileSync(path, "utf8")`. */
  readKey?: (path: string) => string;
  /** Log sink — defaults to a no-op. Never receives the key or token (see the file header). */
  log?: (step: string, extra?: Record<string, unknown>) => void;
}

export interface RefreshResult {
  ok: boolean;
  /** Present on every non-ok result — one of the reasons in {@link TOKEN_REFRESH_REASONS}. */
  reason?: string;
  /** Present only when `ok` — schedules the next refresh (see {@link nextRefreshDelayMs}). */
  expiresAtMs?: number;
}

/**
 * Every reason this module can put on a {@link RefreshResult.reason} or a
 * {@link TOKEN_REFRESH_FAILED_STEP} ledger row, declared once so a later sweep can tell an
 * unrecordable reason (this member can never fire) from a genuinely unobserved one.
 *
 * `recordable` is false only for `"app not configured"`, which returns before any `log` call —
 * its zero is unrecordable by construction, never a measurement. `form` is `"literal"` for an
 * exact match or `"prefix"` for a template whose real row appends a variable suffix (matching a
 * prefix reason as a literal reads a false zero). `writer` names which function's own `log` call
 * produces it — `"refresh threw: "` is {@link startInstallationTokenRefresh}'s, not
 * {@link refreshInstallationToken}'s, so a sweep scoped to only one silently misses the other.
 */
// Why: docs/forensics/github-app.md#tokenrefreshreasonform-and-tokenrefreshreasondeclaration
export type TokenRefreshReasonForm = "literal" | "prefix";

export interface TokenRefreshReasonDeclaration {
  recordable: boolean;
  form: TokenRefreshReasonForm;
  writer: "refreshInstallationToken" | "startInstallationTokenRefresh";
}

export const TOKEN_REFRESH_REASONS: Readonly<Record<string, TokenRefreshReasonDeclaration>> = {
  "app not configured": { recordable: false, form: "literal", writer: "refreshInstallationToken" },
  "private key unreadable": { recordable: true, form: "literal", writer: "refreshInstallationToken" },
  "jwt signing failed": { recordable: true, form: "literal", writer: "refreshInstallationToken" },
  "exchange timed out": { recordable: true, form: "literal", writer: "refreshInstallationToken" },
  "exchange request failed: ": { recordable: true, form: "prefix", writer: "refreshInstallationToken" },
  "exchange rejected: ": { recordable: true, form: "prefix", writer: "refreshInstallationToken" },
  "exchange response unparsable": { recordable: true, form: "literal", writer: "refreshInstallationToken" },
  "exchange response missing token": { recordable: true, form: "literal", writer: "refreshInstallationToken" },
  "refresh threw: ": { recordable: true, form: "prefix", writer: "startInstallationTokenRefresh" },
};

/** Signs a GitHub App JWT with `node:crypto`'s `sign` — in-process, no `openssl` shell-out and
 *  no new dependency. Exported so a test can verify the signature round-trips against the
 *  matching public key without mocking the network exchange. */
// Why: docs/forensics/github-app.md#signappjwt
export function signAppJwt(appId: string, privateKeyPem: string, now: () => number = Date.now): string {
  const nowSec = Math.floor(now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: nowSec - JWT_BACKDATE_SEC, exp: nowSec + JWT_TTL_SEC, iss: appId };
  const encode = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signature = cryptoSign("RSA-SHA256", Buffer.from(signingInput, "utf8"), privateKeyPem).toString(
    "base64url",
  );
  return `${signingInput}.${signature}`;
}

/**
 * Names a caught fetch failure from the error itself: `err.cause.code` when `fetch` wraps a real
 * connection failure (ECONNREFUSED, ENOTFOUND, a TLS failure) in a `TypeError`, else `err.name`
 * when it is more specific than the bare `Error` a plain `new Error(message)` carries. Returns
 * `undefined` for a bare `Error`, which identifies nothing, so the caller can fall through to the
 * abort-only branch instead of inventing a fake identity.
 */
// Why: docs/forensics/github-app.md#fetchfailureidentifier
function fetchFailureIdentifier(err: unknown): string | undefined {
  if (err instanceof Error) {
    const cause = err.cause;
    if (cause && typeof cause === "object" && "code" in cause && typeof (cause as { code: unknown }).code === "string") {
      return (cause as { code: string }).code;
    }
    if (err.name && err.name !== "Error") {
      return err.name;
    }
  }
  return undefined;
}

/**
 * Decides why the exchange's `fetch` rejected, in order: (1) identity-equal to
 * `timeoutController.signal.reason` is our own abort, set with an explicit reason so it can never
 * be confused with a caller's unrelated signal; (2) the error's own identifier, so a rejection
 * that names its real cause is not folded into the timeout bucket just because the 20s budget
 * also expired; (3) the abort-only fallback, reached when the error identifies nothing — the
 * shape the existing test suite already relies on; (4) an unidentified rejection that arrived
 * before any abort.
 */
// Why: docs/forensics/github-app.md#describeexchangecatch
function describeExchangeCatch(err: unknown, timeoutController: AbortController): string {
  if (err === timeoutController.signal.reason) {
    return "exchange timed out";
  }
  const identifier = fetchFailureIdentifier(err);
  if (identifier !== undefined) {
    return `exchange request failed: ${identifier}`;
  }
  if (timeoutController.signal.aborted) {
    return "exchange timed out";
  }
  return "exchange request failed: unknown";
}

const STALLED_TIMER_LATENESS_MS = EXCHANGE_TIMEOUT_MS / 20;

// Aborts after EXCHANGE_TIMEOUT_MS of LOOP-AVAILABLE time: timers run before I/O when a stalled loop
// resumes, so on 2026-10-15 a plain timer aborted 17 delivered exchanges while serve and the socket
// thread minted at once. A timer that fires late (a stall, not a spent budget) re-arms instead.
function exchangeDeadline(controller: AbortController, clock: Clock, reason: string): () => void {
  let timer: ReturnType<typeof setTimeout>;
  const arm = (ms: number): void => {
    const dueAt = clock.now() + ms;
    timer = setTimeout(() => {
      const late = clock.now() - dueAt;
      if (late >= STALLED_TIMER_LATENESS_MS) arm(Math.min(late, EXCHANGE_TIMEOUT_MS));
      else controller.abort(new Error(reason));
    }, ms);
  };
  arm(EXCHANGE_TIMEOUT_MS);
  return () => clearTimeout(timer);
}

/**
 * Mints a fresh installation token and, on success, writes it to `opts.env.GH_TOKEN` (see the
 * file header). On any failure — missing config, an unreadable key, a signing failure, a network
 * failure, a non-2xx exchange, or an unparsable response — `GH_TOKEN` is left untouched. An
 * attempted-and-failed exchange (config was present) logs a named reason; absent config is not an
 * attempt and logs nothing, mirroring `GH_TOKEN`'s own optional shape today.
 */
export async function refreshInstallationToken(opts: RefreshOptions = {}): Promise<RefreshResult> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const fetchFn = opts.fetchImpl ?? fetch;
  const readKey = opts.readKey ?? ((p: string) => readFileSync(p, "utf8"));

  const appId = opts.appId ?? env[GH_APP_ID_ENV];
  const installationId = opts.installationId ?? env[GH_APP_INSTALLATION_ID_ENV];
  const keyPath = opts.privateKeyPath ?? env[GH_APP_PRIVATE_KEY_PATH_ENV];

  if (!appId || !installationId || !keyPath) {
    // Not installed on this host (yet) — not an attempt, so no ledger noise. See file header.
    return { ok: false, reason: "app not configured" };
  }

  let privateKeyPem: string;
  try {
    privateKeyPem = readKey(keyPath);
  } catch {
    log(TOKEN_REFRESH_FAILED_STEP, { reason: "private key unreadable" });
    return { ok: false, reason: "private key unreadable" };
  }

  let jwt: string;
  try {
    jwt = signAppJwt(appId, privateKeyPem, now);
  } catch {
    log(TOKEN_REFRESH_FAILED_STEP, { reason: "jwt signing failed" });
    return { ok: false, reason: "jwt signing failed" };
  }

  // The exchange is abandoned, never awaited forever — see EXCHANGE_TIMEOUT_MS's doc. The timer
  // is armed before the fetch is issued; only how the catch below names a failure changed here.
  let res: Response;
  const timeoutController = new AbortController();
  const cancelDeadline = exchangeDeadline(timeoutController, clockFromMillisFn(now), "token exchange timed out");
  try {
    res = await fetchFn(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: timeoutController.signal,
    });
  } catch (err) {
    // Decide from the caught error first, the abort only when the error says nothing — never
    // from `signal.aborted` alone, which is true for the whole 20s and says nothing about
    // whether the network was ever touched.
    const reason = describeExchangeCatch(err, timeoutController);
    log(TOKEN_REFRESH_FAILED_STEP, { reason });
    return { ok: false, reason };
  } finally {
    cancelDeadline();
  }

  if (!res.ok) {
    // Naming the status keeps a missing-scope 403 from being confused with the rate limit this
    // module exists to route around — see the forensics page for the incident.
    log(TOKEN_REFRESH_FAILED_STEP, { reason: `exchange rejected: ${res.status}` });
    return { ok: false, reason: `exchange rejected: ${res.status}` };
  }

  let body: { token?: string; expires_at?: string };
  try {
    body = (await res.json()) as { token?: string; expires_at?: string };
  } catch {
    log(TOKEN_REFRESH_FAILED_STEP, { reason: "exchange response unparsable" });
    return { ok: false, reason: "exchange response unparsable" };
  }

  if (!body.token || !body.expires_at) {
    log(TOKEN_REFRESH_FAILED_STEP, { reason: "exchange response missing token" });
    return { ok: false, reason: "exchange response missing token" };
  }

  const parsedExpiry = Date.parse(body.expires_at);
  const expiresAtMs = Number.isFinite(parsedExpiry) ? parsedExpiry : now() + INSTALLATION_TOKEN_LIFETIME_MS;

  // The one seam from the file header: every consumer reads process.env at call/spawn time, so
  // this line reaches all three with no call-site change.
  env.GH_TOKEN = body.token;
  log(TOKEN_REFRESHED_STEP, { installation_id: installationId, expires_at: body.expires_at });
  return { ok: true, expiresAtMs };
}

/** {@link mintScopedToken}'s own ledger steps — kept OUT of {@link TOKEN_REFRESH_REASONS}' closed
 *  nine-reason vocabulary (that set is asserted exact, test/token-refresh-reason-provenance.test.ts):
 *  a per-request mint is a different event from the daemon's own ambient refresh (W1-T2699). */
export const SCOPED_TOKEN_MINTED_STEP = "github_app.scoped_token_minted";
/** @see SCOPED_TOKEN_MINTED_STEP */
export const SCOPED_TOKEN_MINT_FAILED_STEP = "github_app.scoped_token_mint_failed";

export interface ScopedTokenResult {
  ok: boolean;
  token?: string;
  /** Capped at `now() + ttlMs`, never GitHub's own fixed one-hour expiry alone (W1-T2398's model). */
  expiresAtMs?: number;
  reason?: string;
}

/**
 * Mint an installation token SCOPED to one repository (design (iii), W1-T2699) — the smallest
 * token a push needs, via `repositories`/`permissions` on the exchange body, never the ambient
 * installation-wide token {@link refreshInstallationToken} mints. Never touches `opts.env`: this
 * is a per-request value for the credential-helper socket (secret-boundary.ts), not `GH_TOKEN`.
 */
export async function mintScopedToken(repo: string, ttlMs: number, opts: RefreshOptions = {}): Promise<ScopedTokenResult> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const fetchFn = opts.fetchImpl ?? fetch;
  const readKey = opts.readKey ?? ((p: string) => readFileSync(p, "utf8"));

  const appId = opts.appId ?? env[GH_APP_ID_ENV];
  const installationId = opts.installationId ?? env[GH_APP_INSTALLATION_ID_ENV];
  const keyPath = opts.privateKeyPath ?? env[GH_APP_PRIVATE_KEY_PATH_ENV];
  if (!appId || !installationId || !keyPath) {
    return { ok: false, reason: "app not configured" };
  }

  let privateKeyPem: string;
  try {
    privateKeyPem = readKey(keyPath);
  } catch {
    log(SCOPED_TOKEN_MINT_FAILED_STEP, { reason: "private key unreadable" });
    return { ok: false, reason: "private key unreadable" };
  }
  let jwt: string;
  try {
    jwt = signAppJwt(appId, privateKeyPem, now);
  } catch {
    log(SCOPED_TOKEN_MINT_FAILED_STEP, { reason: "jwt signing failed" });
    return { ok: false, reason: "jwt signing failed" };
  }

  // REFUSE RATHER THAN WIDEN. A `repo` that names no owner/repo cannot be scoped, and the old
  // fallback answered that by omitting `repositories` entirely — which does not mint a narrower
  // token, it mints the INSTALLATION-WIDE one. That is the opposite of this function's purpose and
  // it was the live path: without `credential.useHttpPath` git sends the helper a bare host, so
  // every mint took this branch (worker.ts's `wireCredentialHelperSocket` now sets it). Failing
  // closed here means a future caller that loses the path gets a refusal it can see, never a
  // silent escalation to the broadest credential the App can issue.
  const name = repo.includes("/") ? repo.split("/")[1] : undefined;
  if (!name) {
    log(SCOPED_TOKEN_MINT_FAILED_STEP, { reason: "request names no owner/repo to scope to" });
    return { ok: false, reason: "request names no owner/repo to scope to" };
  }
  const body = { repositories: [name], permissions: { contents: "write", pull_requests: "write" } };

  const timeoutController = new AbortController();
  const cancelDeadline = exchangeDeadline(timeoutController, clockFromMillisFn(now), "scoped token exchange timed out");
  let res: Response;
  try {
    res = await fetchFn(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: timeoutController.signal,
    });
  } catch (err) {
    const reason = describeExchangeCatch(err, timeoutController);
    log(SCOPED_TOKEN_MINT_FAILED_STEP, { reason });
    return { ok: false, reason };
  } finally {
    cancelDeadline();
  }

  if (!res.ok) {
    log(SCOPED_TOKEN_MINT_FAILED_STEP, { reason: `exchange rejected: ${res.status}` });
    return { ok: false, reason: `exchange rejected: ${res.status}` };
  }
  let parsed: { token?: string; expires_at?: string };
  try {
    parsed = (await res.json()) as { token?: string; expires_at?: string };
  } catch {
    log(SCOPED_TOKEN_MINT_FAILED_STEP, { reason: "exchange response unparsable" });
    return { ok: false, reason: "exchange response unparsable" };
  }
  if (!parsed.token || !parsed.expires_at) {
    log(SCOPED_TOKEN_MINT_FAILED_STEP, { reason: "exchange response missing token" });
    return { ok: false, reason: "exchange response missing token" };
  }

  const realExpiry = Date.parse(parsed.expires_at);
  const cappedExpiry = Math.min(
    Number.isFinite(realExpiry) ? realExpiry : now() + INSTALLATION_TOKEN_LIFETIME_MS,
    now() + ttlMs,
  );
  log(SCOPED_TOKEN_MINTED_STEP, { installation_id: installationId, scoped_repo: repo, expires_at: new Date(cappedExpiry).toISOString() });
  return { ok: true, token: parsed.token, expiresAtMs: cappedExpiry };
}

/**
 * Delay, in ms, until the next refresh should fire — strictly inside the token's remaining life,
 * never at or past its expiry. Clamped at zero so a stale `expiresAtMs` (e.g. a clock jump)
 * schedules an immediate retry rather than a negative delay.
 */
export function nextRefreshDelayMs(expiresAtMs: number, now: number = Date.now(), leadMs: number = REFRESH_MARGIN_MS): number {
  return Math.max(0, expiresAtMs - leadMs - now);
}

/** Once per retained token: a failed refresh has spent half its lead, and the token has expired. */
export const TOKEN_EXPIRING_STEP = "github_app.token_expiring";
export const TOKEN_EXPIRED_STEP = "github_app.token_expired";
const ATTEMPT_CYCLE_SAMPLES = 8;

/** The margin's attempt count at the measured cycle (timer lateness plus exchange), up to half a life. */
export function refreshLeadMs(attemptCycleMs: readonly number[]): number {
  const attempts = REFRESH_MARGIN_MS / (EXCHANGE_TIMEOUT_MS + REFRESH_FAILURE_RETRY_MS);
  const worst = attemptCycleMs.length > 0 ? Math.max(...attemptCycleMs) : 0;
  return Math.min(INSTALLATION_TOKEN_LIFETIME_MS / 2, Math.max(REFRESH_MARGIN_MS, attempts * (worst + REFRESH_FAILURE_RETRY_MS)));
}

function nextFailedRefreshDelayMs(expiresAtMs: number | undefined, now: number): number {
  if (expiresAtMs === undefined) {
    return REFRESH_FAILURE_RETRY_MS;
  }
  const latestSafeStart = expiresAtMs - EXCHANGE_TIMEOUT_MS - REFRESH_FAILURE_RETRY_GUARD_MS;
  return Math.max(0, Math.min(REFRESH_FAILURE_RETRY_MS, latestSafeStart - now));
}

/**
 * Starts this process's installation-token refresh loop and reports whether it armed.
 *
 * Gated on config presence: with no `GH_APP_*` names set this is byte-identical to before this
 * loop existed, and `armed: false` says so explicitly. `ready` settles once the first mint
 * resolves (or fails and is logged), so a caller can wait for a real token before its first
 * GitHub call, and never rejects — a failed mint is caught, logged and rescheduled like every
 * later tick.
 * `firstResult` reports that mint's outcome; `stop` cancels renewal when a run child finishes.
 *
 * Every seam is injectable, so a test drives the reschedule arithmetic with no network call and
 * no live timer. `setTimer` returns the timer so the caller can `unref` it.
 */
// Why: docs/forensics/github-app.md#startinstallationtokenrefresh
export function startInstallationTokenRefresh(opts: {
  log: RefreshOptions["log"];
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  refresh?: (o: RefreshOptions) => Promise<RefreshResult>;
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
  clearTimer?: (timer: { unref?: () => void }) => void;
  now?: () => number;
}): { armed: boolean; ready?: Promise<void>; firstResult?: Promise<RefreshResult>; stop?: () => void } {
  const env = opts.env ?? process.env;
  if (!env[GH_APP_ID_ENV] || !env[GH_APP_INSTALLATION_ID_ENV] || !env[GH_APP_PRIVATE_KEY_PATH_ENV]) {
    return { armed: false };
  }
  const refresh = opts.refresh ?? refreshInstallationToken;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const now = opts.now ?? Date.now;
  let lastSuccessfulExpiresAtMs: number | undefined;
  let stopped = false;
  let timer: { unref?: () => void } | undefined;
  let dueAt = now();
  const cycles: number[] = [];
  let failures = 0;
  const warned = new Set<string>();
  // Arming the next timer must never depend on anything that can itself throw — `setTimer`
  // returning is the only thing this loop's survival rides on.
  const rearm = (delay: number): void => {
    if (stopped) return;
    dueAt = now() + delay;
    timer = setTimer(tick, delay);
    timer.unref?.();
  };
  const settled = (): void => {
    cycles.push(Math.max(0, now() - dueAt));
    if (cycles.length > ATTEMPT_CYCLE_SAMPLES) cycles.shift();
  };
  // A dead token fails every consumer with a 401 that names no cause; these rows name it.
  const warnIfNearExpiry = (reason: string | undefined): void => {
    failures += 1;
    if (lastSuccessfulExpiresAtMs === undefined) return;
    const remaining = lastSuccessfulExpiresAtMs - now();
    const lead = refreshLeadMs(cycles);
    const step = remaining <= 0 ? TOKEN_EXPIRED_STEP : remaining < lead / 2 ? TOKEN_EXPIRING_STEP : undefined;
    if (step === undefined || warned.has(`${step}:${lastSuccessfulExpiresAtMs}`)) return;
    warned.add(`${step}:${lastSuccessfulExpiresAtMs}`);
    opts.log?.(step, {
      expires_at: fixedClock(lastSuccessfulExpiresAtMs).iso(), remaining_ms: remaining, failed_attempts: failures,
      refresh_lead_ms: Math.round(lead), attempt_cycle_ms: Math.max(0, ...cycles), last_reason: reason,
    });
  };
  // The mint-and-rearm body, factored out of `tick` so its promise can be returned to the first
  // caller via `ready`, while every later tick stays fire-and-forget as before.
  const runOnce = (): Promise<RefreshResult> =>
    Promise.resolve().then(() => refresh({ log: opts.log, env })).then(
      (result) => {
        settled();
        if (result.ok && result.expiresAtMs !== undefined) {
          lastSuccessfulExpiresAtMs = result.expiresAtMs;
          failures = 0;
          rearm(nextRefreshDelayMs(result.expiresAtMs, now(), refreshLeadMs(cycles)));
          return result;
        }
        // Once the loop has a retained expiry, failure retries must leave room for one full exchange.
        rearm(nextFailedRefreshDelayMs(lastSuccessfulExpiresAtMs, now()));
        warnIfNearExpiry(result.reason);
        return result;
      },
      (err) => {
        // The promise itself rejected — a throw, not a `{ ok: false }` result. Only `refresh`'s
        // own `log(...)` call can do that (e.g. a ledger write hitting ENOSPC/EACCES/EROFS), so
        // the next timer is armed FIRST, before explaining why — the loop's survival must never
        // depend on a second write to the filesystem that just failed. The explanatory write
        // below is best-effort and guarded: if it throws too, that is swallowed.
        settled();
        rearm(nextFailedRefreshDelayMs(lastSuccessfulExpiresAtMs, now()));
        try {
          opts.log?.(TOKEN_REFRESH_FAILED_STEP, {
            reason: `refresh threw: ${err instanceof Error ? err.message : String(err)}`,
          });
          warnIfNearExpiry("refresh threw");
        } catch {
          // Swallowed on purpose — see comment above.
        }
        return { ok: false, reason: "refresh threw" };
      },
    );
  const tick = (): void => {
    if (!stopped) void runOnce();
  };
  const firstResult = runOnce();
  const ready = firstResult.then(() => undefined);
  const stop = (): void => {
    stopped = true;
    if (timer) (opts.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout)))(timer);
  };
  return { armed: true, ready, firstResult, stop };
}
