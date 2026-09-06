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
 * Trap: a worker's copy of `GH_TOKEN` is fixed at spawn and can outlive the one-hour token on a
 * long run. That gap is accepted, not fixed, here.
 */
// Why: docs/forensics/github-app.md#module-header

// ── W1-T2311 DECISION RECORD: THE BOOT ENV CARRIED THE PAT, NOT THIS MODULE ─────────────────────
//
// A container's boot env used to carry a personal token under GH_TOKEN, which this module's
// refresh (a per-process `process.env` write) could never reach or displace — the root cause was
// one layer out, in how a recycle captured and forwarded that env. See the forensics page for the
// measurement.
//
// REMEDY (a) TAKEN: the boot env now carries no GH_TOKEN at all (deploy/recycle-container.sh); an
// operator reads a container's live token with `docker exec` instead of the fleet holding one on
// their behalf. REMEDY (b) — refusing on a failed exchange instead of degrading — was NOT taken:
// this module never introduced the personal token to refuse around, and refusing would break the
// retry loop's own degrade-never-refuse contract (W1-T1068, REFRESH_MARGIN_MS below). A timed-out
// exchange still leaves the previous value untouched.
//
// UNINVESTIGATED: why roughly one exchange in three used to time out when the same container
// reached GitHub's API in milliseconds unauthenticated. See the forensics page; closing W1-T2311
// does not explain it.
// Why: docs/forensics/github-app.md#the-w1-t2311-decision-record

import { readFileSync } from "node:fs";
import { sign as cryptoSign } from "node:crypto";

/** Env var names, not values — mirrors `GH_TOKEN`'s own shape. `GH_APP_PRIVATE_KEY_PATH_ENV`
 *  names a path to the mounted key file, never the key material itself. */
export const GH_APP_ID_ENV = "GH_APP_ID";
export const GH_APP_INSTALLATION_ID_ENV = "GH_APP_INSTALLATION_ID";
export const GH_APP_PRIVATE_KEY_PATH_ENV = "GH_APP_PRIVATE_KEY_PATH";

/** GitHub's own contract: an installation access token is valid for exactly one hour. */
export const INSTALLATION_TOKEN_LIFETIME_MS = 60 * 60 * 1000;

/** How long before expiry to refresh — strictly inside the token's one-hour life, never at or
 *  past the edge. Five minutes leaves ample time for any single `gh`/`git` call, and doubles as
 *  the retry cadence on a failed mint. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

// GitHub's App-JWT contract: `iat` is backdated for clock skew and `exp` is capped at ten
// minutes. This JWT mints one installation token and is then discarded, so nine minutes of life
// stays under that ceiling with margin.
const JWT_BACKDATE_SEC = 60;
const JWT_TTL_SEC = 9 * 60;

/** Node's `fetch` has no default timeout, so a hung connection would await forever and — since
 *  {@link startInstallationTokenRefresh}'s loop only arms its next timer after this promise
 *  settles — permanently kill the refresh loop. 20s is a generous multiple of a normal exchange's
 *  cost, a reasoned bound rather than a fitted measurement (see the forensics page), and stays
 *  well inside {@link REFRESH_MARGIN_MS}'s five-minute retry cadence. Exported so a test can
 *  advance a mocked clock by exactly this amount. */
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
  const timeoutTimer = setTimeout(
    () => timeoutController.abort(new Error("token exchange timed out")),
    EXCHANGE_TIMEOUT_MS,
  );
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
    clearTimeout(timeoutTimer);
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

/**
 * Delay, in ms, until the next refresh should fire — strictly inside the token's remaining life,
 * never at or past its expiry. Clamped at zero so a stale `expiresAtMs` (e.g. a clock jump)
 * schedules an immediate retry rather than a negative delay.
 */
export function nextRefreshDelayMs(expiresAtMs: number, now: number = Date.now()): number {
  return Math.max(0, expiresAtMs - REFRESH_MARGIN_MS - now);
}

/**
 * Starts the daemon's own installation-token refresh loop and reports whether it armed.
 *
 * Gated on config presence: with no `GH_APP_*` names set this is byte-identical to before this
 * loop existed, and `armed: false` says so explicitly. `ready` settles once the first mint
 * resolves (or fails and is logged), so a caller can wait for a real token before its first
 * GitHub call, and never rejects — a failed mint is caught, logged and rescheduled like every
 * later tick.
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
  now?: () => number;
}): { armed: boolean; ready?: Promise<void> } {
  const env = opts.env ?? process.env;
  if (!env[GH_APP_ID_ENV] || !env[GH_APP_INSTALLATION_ID_ENV] || !env[GH_APP_PRIVATE_KEY_PATH_ENV]) {
    return { armed: false };
  }
  const refresh = opts.refresh ?? refreshInstallationToken;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const now = opts.now ?? Date.now;
  // Arming the next timer must never depend on anything that can itself throw — `setTimer`
  // returning is the only thing this loop's survival rides on.
  const rearm = (delay: number): void => {
    const timer = setTimer(tick, delay);
    timer.unref?.();
  };
  // The mint-and-rearm body, factored out of `tick` so its promise can be returned to the first
  // caller via `ready`, while every later tick stays fire-and-forget as before.
  const runOnce = (): Promise<void> =>
    refresh({ log: opts.log }).then(
      (result) => {
        // A failed mint still reschedules — a transient outage keeps retrying on the margin
        // rather than going silent.
        const delay =
          result.ok && result.expiresAtMs !== undefined
            ? nextRefreshDelayMs(result.expiresAtMs, now())
            : REFRESH_MARGIN_MS;
        rearm(delay);
      },
      (err) => {
        // The promise itself rejected — a throw, not a `{ ok: false }` result. Only `refresh`'s
        // own `log(...)` call can do that (e.g. a ledger write hitting ENOSPC/EACCES/EROFS), so
        // the next timer is armed FIRST, before explaining why — the loop's survival must never
        // depend on a second write to the filesystem that just failed. The explanatory write
        // below is best-effort and guarded: if it throws too, that is swallowed.
        rearm(REFRESH_MARGIN_MS);
        try {
          opts.log?.(TOKEN_REFRESH_FAILED_STEP, {
            reason: `refresh threw: ${err instanceof Error ? err.message : String(err)}`,
          });
        } catch {
          // Swallowed on purpose — see comment above.
        }
      },
    );
  const tick = (): void => {
    void runOnce();
  };
  const ready = runOnce();
  return { armed: true, ready };
}
