/**
 * THE FLEET AUTHENTICATES AS THE INSTALLED GITHUB APP (W1-T1024, MASTER-PLAN §9).
 *
 * THE INCIDENT. `daemon.quota` read `bucket: graphql, remaining: 0` while `core` read 4289 in
 * the SAME second — the two buckets are independent, and the exhausted one belonged to the
 * OPERATOR'S interactive session, not the fleet (the daemon's own graphql traffic in that window
 * was negligible against the 5,000 limit). Two seconds later the HARD_STOP escalation — `gh
 * issue create`, itself graphql — failed on the exact condition it exists to report. That shape
 * recurred on 2026-08-16, 2026-08-17 and 2026-08-19.
 *
 * THE FIX IS A SEPARATE POOL, NOT A HARDER LIMIT ON THE FLEET: an installation token minted
 * against the App reads its OWN `core`/`graphql` buckets, measured independent of whatever an
 * operator's shell is spending. This module mints that token in-process (`crypto.sign`, no
 * `openssl` shell-out, no new dependency — Node's `node:crypto` signs RS256 directly) and
 * refreshes {@link refreshInstallationToken}'s ONE seam: `process.env.GH_TOKEN`.
 *
 * WHY THE ENV VAR IS THE WHOLE FIX. Word-bounded, `GH_TOKEN` has exactly three runtime readers:
 *   - `src/lib/env.ts`'s `ALLOWLIST`     — copied into a worker's child env AT SPAWN
 *   - `src/lib/review.ts`'s env spread   — `{ ...process.env, GH_TOKEN: … }` AT CALL TIME
 *   - `deploy/entrypoint.sh`'s credential helper — stored with `$GH_TOKEN` UNEXPANDED, so git's
 *     own shell re-reads it AT CALL TIME, never written to disk
 * Refreshing `process.env.GH_TOKEN` in the daemon's own process reaches every `gh` spawn, every
 * `git` push and every worker with ZERO call-site change — see {@link refreshInstallationToken}.
 *
 * THE WORKER GAP (design iii), STATED PLAINLY. `env.ts`'s `ALLOWLIST` copies `GH_TOKEN` into a
 * worker's child env AT SPAWN, and that copy is held for the worker's whole run — refreshing
 * THIS process's `process.env.GH_TOKEN` cannot reach an already-spawned child. Runs here
 * routinely exceed the token's one-hour life, so a long worker can in principle outlive its own
 * copy. Of the three ways to close that (a fresh re-read inside the worker, a retry-once-on-401
 * in the push path, or accepting the gap for long runs), this task takes the THIRD: both other
 * options require editing `src/lib/worker.ts` or `src/lib/git-push.ts`, neither of which is in
 * this task's declared file list (a credential module with nothing supplying it to the process is
 * the ships-unwired shape this fleet has already measured once; widening scope to chase every
 * consumer is the OPPOSITE mistake). A long-running worker keeps whatever `GH_TOKEN` it was
 * spawned with for its entire run, exactly as it does today — this task does not make that case
 * worse, it just does not fix it either. Filed as a follow-up, not silently absorbed.
 *
 * FALLBACK IS THE DEFAULT (design iv). Missing config, an unreadable key, a signing failure or a
 * rejected exchange all leave `process.env.GH_TOKEN` EXACTLY as they found it and — for an
 * ATTEMPTED refresh that failed — ledger a named reason. Absent config (the App simply isn't
 * installed on this host yet) is not itself an attempt and logs nothing, mirroring `GH_TOKEN`'s
 * own optional shape today. Nothing here ever refuses to boot.
 *
 * NO SECRET EVER REACHES A LOG LINE OR LEDGER ROW — not the private key, not the minted token,
 * not even a prefix. Every `log(...)` call below carries only the installation id, the token's
 * `expires_at` and a fixed reason string.
 */

// ── W1-T2311 DECISION RECORD: THE BOOT ENV CARRIED THE PAT, NOT THIS MODULE ─────────────────────
//
// MEASURED 2026-08-26: the container's boot env carried a 93-character personal token under
// GH_TOKEN (fingerprint 8d073b4c, user 4397075) from the moment the daemon process started, and
// `refreshInstallationToken` below only ever overwrites `process.env.GH_TOKEN` IN THIS PROCESS —
// so the personal token was never reached by falling back to it, it WAS the default, and the
// App-minted token was the thing that had to arrive to displace it. The root cause sat one layer
// out: `deploy/recycle-container.sh` reads a container's env through `docker inspect`, which
// reports only the STATIC config a container was started with, never a value this module mutates
// in a running process — so no amount of successful refreshing here was ever visible to the NEXT
// recycle, and every recycle re-booted the next container on the same standing personal token.
//
// REMEDY (a) TAKEN (see plan/tasks.d/W1-T2311-*.yaml's Q1): THE BOOT ENV NOW CARRIES NO GH_TOKEN.
// `deploy/recycle-container.sh` still captures the outgoing container's token — its own
// refusal-if-uncaptured guard is unchanged, so an operator never silently loses the only copy —
// but that value is no longer forwarded into the incoming container's own environment (see that
// script's own W1-T2311 section for exactly where, and for the operator read path this displaces:
// a `docker exec` invocation carries its own token per call rather than the fleet holding one on
// an operator's behalf). REMEDY (b) — having the fallback REFUSE on a failed exchange rather than
// degrade — was NOT taken: nothing in THIS module ever introduced a personal token to refuse
// around, and refusing here would still sit in tension with the retry loop's own "degrade, never
// refuse" contract (W1-T1068, REFRESH_MARGIN_MS below), which stays exactly as it was. A
// timed-out exchange still leaves the previous value untouched rather than clearing it — the same
// behaviour as before this task, on a boot value that is no longer a credential worth protecting.
// Nothing added here paces, throttles, sleeps or backs off a call (W1-T1066's own standing rule).
//
// THE SECOND-ORDER QUESTION IS UNINVESTIGATED, RECORDED HERE SO IT IS NOT RE-DERIVED OR GUESSED
// AT BY THE NEXT READER: why did roughly one exchange in three time out at EXCHANGE_TIMEOUT_MS
// when the same container reached GitHub's API in milliseconds unauthenticated? That is its own
// defect, on its own measurement, and closing this task must not be read as having explained it.

import { readFileSync } from "node:fs";
import { sign as cryptoSign } from "node:crypto";

/** Config, never source (design ii) — the same shape `GH_TOKEN` itself has today: a name read
 *  from the environment, never a literal in the tree. `GH_APP_PRIVATE_KEY_PATH` is a PATH to the
 *  mounted key, not the key material itself. */
export const GH_APP_ID_ENV = "GH_APP_ID";
export const GH_APP_INSTALLATION_ID_ENV = "GH_APP_INSTALLATION_ID";
export const GH_APP_PRIVATE_KEY_PATH_ENV = "GH_APP_PRIVATE_KEY_PATH";

/** GitHub's own contract: an installation access token is valid for exactly one hour. */
export const INSTALLATION_TOKEN_LIFETIME_MS = 60 * 60 * 1000;

/** Refresh margin — STRICTLY INSIDE the token's one-hour life (design i: "on a margin well
 *  inside the one-hour life"), never at or past the edge. Five minutes leaves fifty-five minutes
 *  of a live token even on the slowest tick, comfortably larger than any single `gh`/`git`
 *  invocation this fleet makes, and is also the retry cadence on a failed mint (design iv: keep
 *  trying, never go silent). */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

// GitHub's App-JWT contract: `iat` backdated for clock skew, `exp` capped at ten minutes —
// this JWT is used ONCE (to mint an installation token) and then discarded, so nine minutes of
// life is ample and stays under the ceiling with margin.
const JWT_BACKDATE_SEC = 60;
const JWT_TTL_SEC = 9 * 60;

// W1-T1068: NODE'S `fetch` HAS NO DEFAULT TIMEOUT, so a connection that opens and then hangs
// (a stalled socket, a proxy that swallows the response) never settles — the `await` below would
// never return, and because `tick()` in `startInstallationTokenRefresh` only arms its next timer
// AFTER this promise settles (see that function's doc), a hang here is not a slow refresh, it is
// a PERMANENTLY DEAD loop. Reasoned from a bound, not fitted to a measurement: this repo's own
// `board_gateway.fetch_bytes` ledger shape carries no duration field to fit against (10.9s bought
// 26.7 MB over 14 REST calls, but that figure is wall-clock observation, not a re-readable value),
// so 20s is chosen as roughly TWICE that ceiling for a call two orders of magnitude smaller (one
// POST, a tiny JSON body) — generous enough that a healthy-but-slow network never trips it, and
// still two orders inside the five-minute `REFRESH_MARGIN_MS` retry cadence, so a timeout costs
// one retry, never a missed refresh. Exported so a test can advance a mocked clock by EXACTLY
// this amount rather than a magic number that would silently drift out of sync with it.
export const EXCHANGE_TIMEOUT_MS = 20 * 1000;

/**
 * THE TWO STEP NAMES THIS MODULE WRITES, OWNED HERE so there is exactly ONE spelling of each —
 * the same "small module owns its step constant" precedent `src/lib/cost-anomaly.ts`'s
 * `COST_ANOMALY_STEP` and `src/lib/image-drift.ts`'s `IMAGE_DRIFT_STEP` already set, and imported
 * by the reader (`deriveNeedsMe`, `src/lib/status-board.ts`) for the same reason: a second
 * hand-typed copy of a step name is how a reader and a writer silently stop agreeing.
 */
export const TOKEN_REFRESHED_STEP = "github_app.token_refreshed";
/** @see TOKEN_REFRESHED_STEP */
export const TOKEN_REFRESH_FAILED_STEP = "github_app.token_refresh_failed";

export interface RefreshOptions {
  /** Overrides the value `GH_APP_ID_ENV` would otherwise supply — test seam only. */
  appId?: string;
  /** Overrides the value `GH_APP_INSTALLATION_ID_ENV` would otherwise supply — test seam only. */
  installationId?: string;
  /** Overrides the value `GH_APP_PRIVATE_KEY_PATH_ENV` would otherwise supply — test seam only. */
  privateKeyPath?: string;
  /** Defaults to `process.env` — the SAME object every consumer above already reads, so setting
   *  `GH_TOKEN` on it reaches all three with no call-site change. A test passes a throwaway
   *  object instead of mutating the real process environment. */
  env?: NodeJS.ProcessEnv;
  /** Injectable clock — defaults to `Date.now`. */
  now?: () => number;
  /** Injectable fetch — defaults to the global `fetch` (Node's own, no dependency). Mirrors
   *  `src/lib/service.ts`'s identical `fetchImpl: typeof fetch = fetch` seam. */
  fetchImpl?: typeof fetch;
  /** Injectable private-key reader — defaults to `readFileSync(path, "utf8")`. */
  readKey?: (path: string) => string;
  /** Ledger/log sink — defaults to a no-op. Never receives the key or the token (see file
   *  header); only the installation id, the token's `expires_at`, or a fixed reason string. */
  log?: (step: string, extra?: Record<string, unknown>) => void;
}

export interface RefreshResult {
  ok: boolean;
  /** Present on every non-ok result — see file header, never the reason a caller passes to a log
   *  line without a value alongside it. */
  reason?: string;
  /** Present only when `ok` — the minted token's expiry, for the caller to schedule the NEXT
   *  refresh off (see {@link nextRefreshDelayMs}). */
  expiresAtMs?: number;
}

/**
 * W1-T2319 design (v) — Q2, RECORDABILITY DECLARED IN CODE, CHECKED BY A TEST, NOT A NEW GATE.
 *
 * Every reason this module (or its sibling function below) can put on a `RefreshResult.reason` /
 * a `TOKEN_REFRESH_FAILED_STEP` ledger row, declared once so a later sweep can tell an
 * UNRECORDABLE zero (this member cannot fire) from a genuinely unobserved one, and a PREFIX form
 * (carries a variable suffix — matching it as a literal reads a false zero, rationale (4)) from a
 * LITERAL one.
 *
 *   - `recordable`: whether a `log(TOKEN_REFRESH_FAILED_STEP, ...)` call site exists that can
 *     produce this reason. `app not configured` is the one `false`: it RETURNS before any `log`
 *     call (design ii — absent config is not an attempt), so its zero is unrecordable by
 *     construction, never a measurement.
 *   - `form`: `"literal"` reasons match a ledger row's `reason` field exactly. `"prefix"` reasons
 *     are TEMPLATES — the string here is the fixed stem a real row's `reason` STARTS WITH, never
 *     the whole value (e.g. a row reads `exchange rejected: 403`, not `exchange rejected: `).
 *   - `writer`: which function's own `log` call can produce this reason. `refresh threw: ` is
 *     `startInstallationTokenRefresh`'s, not `refreshInstallationToken`'s — a sweep scoped to only
 *     one of the two silently misses the other (rationale (4)).
 */
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

/**
 * Signs a GitHub App JWT with `crypto.sign` — an IN-PROCESS, ONE-SHOT call (Node's own
 * `node:crypto`, confirmed `typeof crypto.sign === "function"` under the fleet's own runtime) —
 * never an `openssl` shell-out and never a new dependency (design i). Exported so a test can
 * verify the signature round-trips against the matching public key without mocking the network
 * exchange at all.
 */
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
 * W1-T2319 design (iv) — the error's OWN identifier, when it carries one: `err.cause.code` where
 * present (Node's `fetch` wraps a real connection failure — ECONNREFUSED, ENOTFOUND, a TLS
 * failure — in a `TypeError` whose `.cause` is the underlying `SystemError`/`AggregateError`
 * carrying `.code`), else `err.name` PROVIDED it is more specific than the bare `Error` a plain
 * `new Error(message)` carries by default. A bare `Error` — the shape "a test fixture's own
 * rejection once its signal fires" takes (design ii) — identifies nothing, so this returns
 * `undefined` for it rather than the uninformative literal string `"Error"`, which is what lets
 * the caller fall through to the abort-only branch instead of manufacturing a fake identity.
 */
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
 * W1-T2319 — THE ONE HELPER THE CATCH ARM CONSULTS, ORDER IS THE WHOLE FIX (design i).
 *
 *   1. IDENTITY FIRST. `AbortController.abort(reason)` sets `signal.reason` to that exact object
 *      and a spec-compliant `fetch` rejects with THAT SAME OBJECT, so `err === signal.reason`
 *      identifies OUR OWN abort with no string match and no `err.name` sniff (which a caller's
 *      unrelated signal could also satisfy) — see the abort call above, which always passes an
 *      explicit reason for exactly this.
 *   2. THE ERROR'S OWN IDENTIFIER SECOND, REACHABLE EVEN ON AN ALREADY-ABORTED SIGNAL (design
 *      iii/iv): a rejection that names its own cause — a refused connection, a DNS failure, a TLS
 *      failure — is named for what it is rather than folded into the timeout bucket just because
 *      the 20s budget happened to also have expired.
 *   3. THE ABORT-ONLY FALLBACK LAST, reached only when the error identifies nothing (design ii) —
 *      the seam the existing test suite already relies on: a fixture that rejects with a bare
 *      `Error` once its signal fires still reads as a timeout.
 *   4. Otherwise: a genuine, unidentified rejection that arrived before any abort — reachable in
 *      principle (design (7)), named without inventing a code that was never offered.
 */
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
 * Mints a fresh installation token and, on success, writes it into `opts.env.GH_TOKEN` — the one
 * place every existing consumer already reads (file header). On ANY failure — config absent, key
 * unreadable, signing failure, network failure, a non-2xx exchange, or an unparsable response —
 * `opts.env.GH_TOKEN` is left completely untouched (design iv: degrade to the old pool, never
 * refuse). An ATTEMPTED-and-failed exchange (config was present) ledgers a named reason; absent
 * config is not an attempt and logs nothing, mirroring `GH_TOKEN`'s own optional shape today.
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

  // W1-T1068: the exchange is ABANDONED, never awaited forever — see EXCHANGE_TIMEOUT_MS's doc
  // for why 20s. The timer is armed BEFORE the fetch is issued, exactly as before this task —
  // W1-T2319 changes only how the catch below NAMES what it caught, never when or whether the
  // exchange is abandoned.
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
    // W1-T2319: DECIDE FROM THE CAUGHT ERROR FIRST, FROM THE ABORT ONLY WHEN THE ERROR SAYS
    // NOTHING (design i/ii) — never from `signal.aborted` alone, which is true for the WHOLE
    // twenty seconds since the timer was armed and says nothing about whether the network was
    // ever touched during it.
    const reason = describeExchangeCatch(err, timeoutController);
    log(TOKEN_REFRESH_FAILED_STEP, { reason });
    return { ok: false, reason };
  } finally {
    clearTimeout(timeoutTimer);
  }

  if (!res.ok) {
    // design (v): a 403 here reads exactly like a missing-scope rejection, not the rate limit
    // this whole task exists to route around — naming the status keeps the two from being
    // confused again the way this incident already confused them once.
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

  // THE SEAM (file header): every existing GH_TOKEN consumer reads process.env at call/spawn
  // time, so this line — and only this line — is what reaches all three with no call-site change.
  env.GH_TOKEN = body.token;
  log(TOKEN_REFRESHED_STEP, { installation_id: installationId, expires_at: body.expires_at });
  return { ok: true, expiresAtMs };
}

/**
 * Delay, in ms, until the NEXT refresh should fire — strictly inside the token's remaining life
 * (design i), never at or past its expiry. Clamped at zero so an already-stale `expiresAtMs`
 * (e.g. a clock jump) schedules an immediate retry rather than a negative delay.
 */
export function nextRefreshDelayMs(expiresAtMs: number, now: number = Date.now()): number {
  return Math.max(0, expiresAtMs - REFRESH_MARGIN_MS - now);
}

/**
 * Start the daemon's own installation-token refresh loop, and report whether it armed.
 *
 * EXTRACTED FROM `daemonCommand` SO THE LOOP IS TESTABLE AT ALL. Inline at the call site the whole
 * body sat behind a three-variable env gate that no test sets, so every line of it was added
 * source with zero covering tests — `diff-coverage` blocked the PR naming exactly those lines. The
 * gate itself is the only part a daemon-boot test can reach, so the body has to move somewhere a
 * test can call directly; the call site keeps one line and the behaviour is unchanged.
 *
 * GATED ON CONFIG PRESENCE, as before: an unconfigured host (the App not installed there yet) is
 * byte-identical to before this task — zero ledger lines, zero timers, `GH_TOKEN`'s own optional
 * shape preserved — and `armed: false` says so to the caller rather than silently doing nothing.
 *
 * Every seam is injectable and defaults to the real thing, so a test drives the reschedule
 * arithmetic without a network call or a live timer: `refresh` mints, `setTimer` schedules, `now`
 * stamps. `setTimer` returns the timer so the caller can `unref` it — an armed refresher must
 * never hold the process open.
 */
export function startInstallationTokenRefresh(opts: {
  log: RefreshOptions["log"];
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  refresh?: (o: RefreshOptions) => Promise<RefreshResult>;
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
  now?: () => number;
}): { armed: boolean } {
  const env = opts.env ?? process.env;
  if (!env[GH_APP_ID_ENV] || !env[GH_APP_INSTALLATION_ID_ENV] || !env[GH_APP_PRIVATE_KEY_PATH_ENV]) {
    return { armed: false };
  }
  const refresh = opts.refresh ?? refreshInstallationToken;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const now = opts.now ?? Date.now;
  // W1-T1068: arming the NEXT timer must never depend on anything that can itself throw — see
  // `rearm`'s two call sites below. `setTimer` returning is the only thing this loop's survival
  // rides on.
  const rearm = (delay: number): void => {
    const timer = setTimer(tick, delay);
    timer.unref?.();
  };
  const tick = (): void => {
    void refresh({ log: opts.log }).then(
      (result) => {
        // A FAILED MINT STILL RESCHEDULES (design iv: degrade, never refuse) — a transient outage
        // keeps retrying on the margin rather than going silent.
        const delay =
          result.ok && result.expiresAtMs !== undefined
            ? nextRefreshDelayMs(result.expiresAtMs, now())
            : REFRESH_MARGIN_MS;
        rearm(delay);
      },
      (err) => {
        // THE PROMISE ITSELF REJECTED — not a `{ ok: false }` result, but a THROW. The only thing
        // inside `refresh` that can do that is its own `log(...)` call (e.g. `appendLedger`
        // hitting ENOSPC/EACCES/EROFS — design (2)), so the ledger is very likely the reason we're
        // here. The next timer is armed FIRST, before any attempt to explain why, so the loop's
        // survival never depends on a second write to the same filesystem that just failed
        // (design ii). The explanatory write below is best-effort only, and guarded: if it throws
        // too, that is swallowed, never left to take the already-armed timer down with it.
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
  };
  tick();
  return { armed: true };
}
