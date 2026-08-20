// test/github-app.test.ts — W1-T1024: THE FLEET AUTHENTICATES AS THE INSTALLED GITHUB APP.
//
// Covers the five unit-test acceptance criteria in plan/tasks.d/W1-T1024-…yaml verbatim:
//   1. a refreshed token reaches a spawned child through the environment without any call site
//      change (buildWorkerEnv — env.ts's own ALLOWLIST — reads whatever this module wrote)
//   2. the jwt is signed in process (crypto.sign) without shelling out to openssl
//   3. a failed exchange leaves the existing static token in place and ledgers a named reason
//   4. no ledger row or log line carries the private key or the token value
//   5. the refresh margin is strictly inside the one hour token life
import assert from "node:assert/strict";
import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mock, test } from "node:test";

import { buildWorkerEnv } from "../src/lib/env.js";
import {
  EXCHANGE_TIMEOUT_MS,
  GH_APP_ID_ENV,
  GH_APP_INSTALLATION_ID_ENV,
  GH_APP_PRIVATE_KEY_PATH_ENV,
  INSTALLATION_TOKEN_LIFETIME_MS,
  REFRESH_MARGIN_MS,
  nextRefreshDelayMs,
  refreshInstallationToken,
  signAppJwt,
  startInstallationTokenRefresh,
} from "../src/lib/github-app.js";

function keyPair() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

// ── (2) THE JWT IS SIGNED IN PROCESS, NEVER SHELLED OUT TO openssl ─────────────────────────────

test("W1-T1024: the app jwt is signed in process without an openssl shell out", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/lib/github-app.ts", import.meta.url)), "utf8");
  // No child_process import at all, and no shell-out call of any kind — the ONLY signing
  // mechanism in this file is node:crypto's own one-shot `sign` (imported below). (The doc
  // comment above names "openssl" in prose, explaining why it's NOT used — this checks for an
  // actual shell-out call, not the word.)
  assert.ok(!/child_process/.test(src), "github-app.ts must not import node:child_process");
  assert.ok(!/execFileSync|execSync|spawnSync|\bexecFile\(|\bspawn\(/.test(src), "github-app.ts must not shell out");
  assert.ok(/from "node:crypto"/.test(src), "github-app.ts must sign via node:crypto");

  const { publicKey, privateKey } = keyPair();
  const fixedNow = () => Date.parse("2026-08-20T12:00:00.000Z");
  const jwt = signAppJwt("app-123", privateKey, fixedNow);

  const parts = jwt.split(".");
  assert.equal(parts.length, 3);
  const [headerB64, payloadB64, signatureB64] = parts;
  const header = decodeSegment(headerB64);
  const payload = decodeSegment(payloadB64);
  assert.equal(header.alg, "RS256");
  assert.equal(payload.iss, "app-123");
  assert.equal(payload.iat, Math.floor(fixedNow() / 1000) - 60);
  assert.equal(payload.exp, Math.floor(fixedNow() / 1000) + 9 * 60);

  // The signature verifies against the MATCHING public key — proof this is a real RSA-SHA256
  // signature `crypto.sign` produced in this process, not a placeholder string.
  const signedInput = Buffer.from(`${headerB64}.${payloadB64}`, "utf8");
  const signature = Buffer.from(signatureB64, "base64url");
  assert.ok(cryptoVerify("RSA-SHA256", signedInput, publicKey, signature));

  // A signature over a DIFFERENT input must NOT verify — the control that the check above is
  // actually exercising the signature, not vacuously true.
  const tamperedInput = Buffer.from(`${headerB64}.${payloadB64}x`, "utf8");
  assert.ok(!cryptoVerify("RSA-SHA256", tamperedInput, publicKey, signature));
});

// ── (1) A REFRESHED TOKEN REACHES A SPAWNED CHILD THROUGH THE ENVIRONMENT ──────────────────────

test("W1-T1024: a refreshed token reaches a spawned child through the environment", async () => {
  const { privateKey } = keyPair();
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: "/home/node", GH_TOKEN: "OLD-STATIC-TOKEN" };
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];

  const result = await refreshInstallationToken({
    appId: "app-1",
    installationId: "inst-1",
    privateKeyPath: "/fake/key.pem",
    env,
    readKey: () => privateKey,
    fetchImpl: (async () =>
      fakeResponse(201, { token: "ghs_FRESH_APP_TOKEN", expires_at: "2026-08-20T13:00:00Z" })) as typeof fetch,
    log: (step, extra = {}) => logs.push({ step, extra }),
  });

  assert.equal(result.ok, true);
  assert.equal(env.GH_TOKEN, "ghs_FRESH_APP_TOKEN");

  // No call-site change: env.ts's ALLOWLIST (buildWorkerEnv) reads process.env — here, this SAME
  // `env` object — at spawn time, and picks up whatever the refresher just wrote.
  const childEnv = buildWorkerEnv({}, env);
  assert.equal(childEnv.GH_TOKEN, "ghs_FRESH_APP_TOKEN");
});

// ── (3) A FAILED EXCHANGE FALLS BACK TO THE STATIC TOKEN WITH A REASON ──────────────────────────

test("W1-T1024: a failed exchange falls back to the static token with a reason", async () => {
  const { privateKey } = keyPair();
  const env: NodeJS.ProcessEnv = { GH_TOKEN: "OLD-STATIC-TOKEN" };
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];

  const result = await refreshInstallationToken({
    appId: "app-1",
    installationId: "inst-1",
    privateKeyPath: "/fake/key.pem",
    env,
    readKey: () => privateKey,
    fetchImpl: (async () => fakeResponse(403, { message: "forbidden" })) as typeof fetch,
    log: (step, extra = {}) => logs.push({ step, extra }),
  });

  assert.equal(result.ok, false);
  assert.equal(typeof result.reason, "string");
  assert.ok(result.reason!.length > 0);
  // The static token this fleet was already using is left EXACTLY as it was.
  assert.equal(env.GH_TOKEN, "OLD-STATIC-TOKEN");

  const failureLine = logs.find((l) => l.step === "github_app.token_refresh_failed");
  assert.ok(failureLine, "a failed exchange must ledger a named reason");
  assert.equal(typeof failureLine!.extra.reason, "string");
  assert.ok((failureLine!.extra.reason as string).length > 0);

  // A network-level throw (not just a non-2xx) falls back identically.
  const envAfterNetworkFailure: NodeJS.ProcessEnv = { GH_TOKEN: "OLD-STATIC-TOKEN" };
  const networkResult = await refreshInstallationToken({
    appId: "app-1",
    installationId: "inst-1",
    privateKeyPath: "/fake/key.pem",
    env: envAfterNetworkFailure,
    readKey: () => privateKey,
    fetchImpl: (async () => {
      throw new Error("ECONNRESET");
    }) as typeof fetch,
    log: (step, extra = {}) => logs.push({ step, extra }),
  });
  assert.equal(networkResult.ok, false);
  assert.equal(envAfterNetworkFailure.GH_TOKEN, "OLD-STATIC-TOKEN");
});

// ── (4) NO LEDGER ROW OR LOG LINE CARRIES THE KEY OR TOKEN VALUE ────────────────────────────────

test("W1-T1024: no ledger row or log line carries the key or token value", async () => {
  const { privateKey } = keyPair();
  const SECRET_TOKEN = "ghs_SUPER_SECRET_DO_NOT_LOG_ME";
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const log = (step: string, extra: Record<string, unknown> = {}) => logs.push({ step, extra });

  // Success path.
  const okEnv: NodeJS.ProcessEnv = {};
  await refreshInstallationToken({
    appId: "app-1",
    installationId: "inst-1",
    privateKeyPath: "/fake/key.pem",
    env: okEnv,
    readKey: () => privateKey,
    fetchImpl: (async () =>
      fakeResponse(201, { token: SECRET_TOKEN, expires_at: "2026-08-20T13:00:00Z" })) as typeof fetch,
    log,
  });

  // Failure paths: unreadable key, signing failure (malformed key), rejected exchange.
  await refreshInstallationToken({
    appId: "app-1",
    installationId: "inst-1",
    privateKeyPath: "/fake/key.pem",
    env: {},
    readKey: () => {
      throw new Error("ENOENT: /fake/key.pem");
    },
    fetchImpl: (async () => fakeResponse(201, { token: SECRET_TOKEN, expires_at: "x" })) as typeof fetch,
    log,
  });
  await refreshInstallationToken({
    appId: "app-1",
    installationId: "inst-1",
    privateKeyPath: "/fake/key.pem",
    env: {},
    readKey: () => "not a real private key " + privateKey,
    fetchImpl: (async () => fakeResponse(201, { token: SECRET_TOKEN, expires_at: "x" })) as typeof fetch,
    log,
  });
  await refreshInstallationToken({
    appId: "app-1",
    installationId: "inst-1",
    privateKeyPath: "/fake/key.pem",
    env: {},
    readKey: () => privateKey,
    fetchImpl: (async () => fakeResponse(401, { token: SECRET_TOKEN })) as typeof fetch,
    log,
  });

  assert.ok(logs.length > 0, "the scenarios above must have produced at least one log line");
  const serialized = JSON.stringify(logs);
  assert.ok(!serialized.includes(SECRET_TOKEN), "no log line may carry the minted token value");
  assert.ok(!serialized.includes(privateKey), "no log line may carry the private key");
  assert.ok(!serialized.includes("BEGIN RSA PRIVATE KEY"), "no log line may carry key material");
});

// ── (5) THE REFRESH MARGIN IS STRICTLY INSIDE THE ONE HOUR TOKEN LIFE ───────────────────────────

test("W1-T1024: the refresh margin is strictly inside the token life", () => {
  assert.equal(INSTALLATION_TOKEN_LIFETIME_MS, 60 * 60 * 1000);
  assert.ok(REFRESH_MARGIN_MS > 0, "a zero margin would refresh exactly at expiry, not before it");
  assert.ok(
    REFRESH_MARGIN_MS < INSTALLATION_TOKEN_LIFETIME_MS,
    "the margin must be strictly inside the token's one hour life",
  );

  const now = Date.parse("2026-08-20T12:00:00.000Z");
  const expiresAtMs = now + INSTALLATION_TOKEN_LIFETIME_MS;
  const delay = nextRefreshDelayMs(expiresAtMs, now);

  assert.equal(delay, INSTALLATION_TOKEN_LIFETIME_MS - REFRESH_MARGIN_MS);
  assert.ok(delay > 0);
  assert.ok(delay < INSTALLATION_TOKEN_LIFETIME_MS, "the next refresh must fire before the token expires");

  // A clock jump past expiry never yields a negative delay — an immediate retry, not a crash.
  assert.equal(nextRefreshDelayMs(now - 1000, now), 0);
});

// ── absent config is a no-op, not a failure (mirrors GH_TOKEN's own optional shape today) ───────

test("W1-T1024: absent App configuration leaves GH_TOKEN untouched and logs nothing", async () => {
  const env: NodeJS.ProcessEnv = { GH_TOKEN: "OLD-STATIC-TOKEN" };
  const logs: Array<{ step: string }> = [];
  const result = await refreshInstallationToken({ env, log: (step) => logs.push({ step }) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "app not configured");
  assert.equal(env.GH_TOKEN, "OLD-STATIC-TOKEN");
  assert.equal(logs.length, 0);
});

// ── the daemon's refresh loop, extracted so it can be reached at all ────────────────────────

test("startInstallationTokenRefresh: an unconfigured host arms nothing and stays byte-identical to before", () => {
  // THE GATE IS THE WHOLE SAFETY PROPERTY. A host where the App is not installed must see zero
  // timers and zero ledger lines — `armed: false` states that to the caller rather than leaving it
  // to be inferred from nothing happening.
  const logged: string[] = [];
  let refreshes = 0;
  let timers = 0;
  const res = startInstallationTokenRefresh({
    log: (step) => logged.push(step),
    env: {},
    refresh: async () => { refreshes += 1; return { ok: true, expiresAtMs: 0 }; },
    setTimer: () => { timers += 1; return {}; },
  });
  assert.equal(res.armed, false);
  assert.equal(refreshes, 0, "no mint on an unconfigured host");
  assert.equal(timers, 0, "no timer on an unconfigured host");
  assert.deepEqual(logged, [], "no ledger line on an unconfigured host");
});

test("startInstallationTokenRefresh: a configured host mints once and reschedules off the minted expiry", async () => {
  const NOW = 1_700_000_000_000;
  const EXPIRES = NOW + 60 * 60 * 1000;
  let refreshes = 0;
  const delays: number[] = [];
  let unrefs = 0;
  const res = startInstallationTokenRefresh({
    log: () => {},
    env: { [GH_APP_ID_ENV]: "1", [GH_APP_INSTALLATION_ID_ENV]: "2", [GH_APP_PRIVATE_KEY_PATH_ENV]: "/k.pem" },
    refresh: async () => { refreshes += 1; return { ok: true, expiresAtMs: EXPIRES }; },
    setTimer: (_fn, ms) => { delays.push(ms); return { unref: () => { unrefs += 1; } }; },
    now: () => NOW,
  });
  assert.equal(res.armed, true);
  await new Promise((r) => setImmediate(r)); // let the mint's .then settle
  assert.equal(refreshes, 1, "mints once immediately");
  assert.deepEqual(delays, [nextRefreshDelayMs(EXPIRES, NOW)], "reschedules off the minted expiry, not a fixed interval");
  assert.equal(unrefs, 1, "an armed refresher must never hold the process open");
});

test("startInstallationTokenRefresh: a FAILED mint still reschedules on the margin rather than going silent", async () => {
  // DEGRADE, NEVER REFUSE. A transient outage must keep retrying; a loop that stopped on the first
  // failure would leave the daemon on a token it can no longer renew, which is the failure this
  // whole mechanism exists to prevent.
  const delays: number[] = [];
  const res = startInstallationTokenRefresh({
    log: () => {},
    env: { [GH_APP_ID_ENV]: "1", [GH_APP_INSTALLATION_ID_ENV]: "2", [GH_APP_PRIVATE_KEY_PATH_ENV]: "/k.pem" },
    refresh: async () => ({ ok: false, reason: "boom" }) as never,
    setTimer: (_fn, ms) => { delays.push(ms); return {}; },
  });
  assert.equal(res.armed, true);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(delays, [REFRESH_MARGIN_MS], "a failed mint retries on the margin");
});

// ── the two failure arms of the exchange response, one test each ────────────────────────────

test("refreshInstallationToken: an UNPARSABLE exchange response degrades with a named reason, never a throw", async () => {
  // ITS OWN TEST BECAUSE A CATCH ARM IS ONLY REACHABLE ONE WAY. Every other fixture here returns
  // well-formed JSON, so this arm was added source with no covering test and diff-coverage named
  // it. A refresher that threw here would take the daemon's boot down on a malformed response.
  const { privateKey } = keyPair();
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const result = await refreshInstallationToken({
    appId: "app-1",
    installationId: "inst-1",
    privateKeyPath: "/fake/key.pem",
    env: {},
    readKey: () => privateKey,
    fetchImpl: (async () => ({
      ok: true,
      status: 201,
      json: async () => { throw new Error("not json"); },
    })) as unknown as typeof fetch,
    log: (step, extra = {}) => logs.push({ step, extra }),
  });
  assert.equal(result.ok, false);
  assert.match(String((result as { reason?: string }).reason), /unparsable/);
  assert.ok(logs.some((l) => l.step === "github_app.token_refresh_failed"), "the failure is ledgered");
});

test("refreshInstallationToken: an exchange response MISSING the token degrades rather than storing undefined", async () => {
  // The sibling arm: valid JSON, absent fields. Storing `undefined` as GH_TOKEN would be worse
  // than failing, because every consumer reads that variable at call time.
  const { privateKey } = keyPair();
  const env: NodeJS.ProcessEnv = { GH_TOKEN: "OLD-STATIC-TOKEN" };
  const result = await refreshInstallationToken({
    appId: "app-1",
    installationId: "inst-1",
    privateKeyPath: "/fake/key.pem",
    env,
    readKey: () => privateKey,
    fetchImpl: (async () => fakeResponse(201, { expires_at: "2026-08-20T13:00:00Z" })) as typeof fetch,
    log: () => {},
  });
  assert.equal(result.ok, false);
  assert.match(String((result as { reason?: string }).reason), /missing token/);
  assert.equal(env.GH_TOKEN, "OLD-STATIC-TOKEN", "the existing token is left alone on a bad response");
});

// ── W1-T1068: THE INSTALLATION-TOKEN REFRESHER CAN DIE SILENTLY AND PERMANENTLY ─────────────────
//
// Two gaps, closed at the two injected seams the design names (`fetchImpl`/`log` on
// `refreshInstallationToken`, `refresh`/`setTimer` on `startInstallationTokenRefresh`):
//   (i)  the exchange fetch now carries a timeout, so a hung socket is abandoned, not awaited
//        forever — driven with `mock.timers` so the test advances a FAKE clock by exactly
//        EXCHANGE_TIMEOUT_MS rather than sleeping for it.
//   (ii) the refresh promise's rejection (e.g. a throwing ledger `log`) still arms the next timer,
//        and does so BEFORE any best-effort explanatory write, never depending on that write
//        succeeding.

test("W1-T1068: a hung exchange is abandoned rather than awaited forever", async () => {
  const { privateKey } = keyPair();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let aborted = false;
    // The hung socket itself: a promise that NEVER settles on its own — the only way it ever
    // settles is if something aborts it, which is exactly the property under test.
    const hungFetch = (async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("hung socket abandoned on signal"));
        });
      })) as unknown as typeof fetch;

    const promise = refreshInstallationToken({
      appId: "app-1",
      installationId: "inst-1",
      privateKeyPath: "/fake/key.pem",
      env: {},
      readKey: () => privateKey,
      fetchImpl: hungFetch,
      log: () => {},
    });

    // Advances a FAKE clock by exactly the production timeout — no real wall-clock wait, which is
    // the decisive proof this is a real abandon-on-timeout, not a coincidence of a short test.
    mock.timers.tick(EXCHANGE_TIMEOUT_MS);
    const result = await promise;

    assert.equal(aborted, true, "the hung request must be aborted rather than left dangling forever");
    assert.equal(result.ok, false, "an abandoned exchange must resolve to a failure, never hang the caller");
  } finally {
    mock.timers.reset();
  }
});

test("W1-T1068: an abandoned exchange logs a named timeout reason", async () => {
  const { privateKey } = keyPair();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
    const hungFetch = (async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("hung socket abandoned on signal")));
      })) as unknown as typeof fetch;

    const result = await (async () => {
      const p = refreshInstallationToken({
        appId: "app-1",
        installationId: "inst-1",
        privateKeyPath: "/fake/key.pem",
        env: {},
        readKey: () => privateKey,
        fetchImpl: hungFetch,
        log: (step, extra = {}) => logs.push({ step, extra }),
      });
      mock.timers.tick(EXCHANGE_TIMEOUT_MS);
      return p;
    })();

    assert.equal(result.ok, false);
    assert.match(String((result as { reason?: string }).reason), /timed out|timeout/i);

    // JOINS the existing failure arms (rationale (0)): same step name, its OWN named reason.
    const failureLine = logs.find((l) => l.step === "github_app.token_refresh_failed");
    assert.ok(failureLine, "an abandoned exchange must ledger a named reason, exactly like every other failure arm");
    assert.match(String(failureLine!.extra.reason), /timed out|timeout/i);
    // Distinguishable from the pre-existing network-throw arm, so an operator reading the ledger
    // can tell "the socket never opened" from "the socket opened and then hung" (design i).
    assert.notEqual(failureLine!.extra.reason, "exchange request failed");
  } finally {
    mock.timers.reset();
  }
});

test("W1-T1068: a rejected refresh still arms the next timer", async () => {
  const delays: number[] = [];
  const res = startInstallationTokenRefresh({
    log: () => {},
    env: { [GH_APP_ID_ENV]: "1", [GH_APP_INSTALLATION_ID_ENV]: "2", [GH_APP_PRIVATE_KEY_PATH_ENV]: "/k.pem" },
    // `refresh` REJECTS outright — not `{ ok: false }` — the shape a throwing `log(...)` inside
    // `refreshInstallationToken` produces (rationale (2)).
    refresh: async () => {
      throw new Error("ledger write failed: ENOSPC");
    },
    setTimer: (_fn, ms) => {
      delays.push(ms);
      return {};
    },
  });
  assert.equal(res.armed, true);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(
    delays,
    [REFRESH_MARGIN_MS],
    "a rejected refresh must retry on the margin, exactly like a resolved { ok: false } failure — a dead loop is the outage this task exists to close",
  );
});

test("W1-T1068: a throwing ledger write still leaves the loop armed", async () => {
  const { privateKey } = keyPair();
  const delays: number[] = [];
  const throwingLog = (): void => {
    throw new Error("ENOSPC: no space left on device");
  };

  // The REAL `refreshInstallationToken` — not a stub — so this exercises the exact path
  // rationale (2) names: a rejected (non-2xx) exchange calls `log(...)`, and it is THAT throw
  // that must not take the loop down with it.
  const res = startInstallationTokenRefresh({
    log: throwingLog,
    env: { [GH_APP_ID_ENV]: "1", [GH_APP_INSTALLATION_ID_ENV]: "2", [GH_APP_PRIVATE_KEY_PATH_ENV]: "/k.pem" },
    refresh: (o) =>
      refreshInstallationToken({
        ...o,
        appId: "app-1",
        installationId: "inst-1",
        privateKeyPath: "/fake/key.pem",
        env: {},
        readKey: () => privateKey,
        fetchImpl: (async () => fakeResponse(403, { message: "forbidden" })) as typeof fetch,
      }),
    setTimer: (_fn, ms) => {
      delays.push(ms);
      return {};
    },
  });

  assert.equal(res.armed, true);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(
    delays,
    [REFRESH_MARGIN_MS],
    "a throwing ledger write (ENOSPC/EACCES/EROFS) must not stop the loop rearming",
  );
});

test("W1-T1068: the next timer is armed before any explanatory write", async () => {
  // THE DECISIVE ORDERING (design ii): a rejection must arm the next timer BEFORE it attempts any
  // best-effort write explaining why — never after, because a second throw from that write must
  // not be able to take an unarmed loop down with it. Every explanatory write here also throws, so
  // a wrong ordering (write-then-arm) would leave `order` with NO `setTimer` entry at all.
  const order: string[] = [];
  const res = startInstallationTokenRefresh({
    log: (step) => {
      order.push(`log:${step}`);
      throw new Error("the same broken ledger — this explanatory write fails too");
    },
    env: { [GH_APP_ID_ENV]: "1", [GH_APP_INSTALLATION_ID_ENV]: "2", [GH_APP_PRIVATE_KEY_PATH_ENV]: "/k.pem" },
    refresh: async () => {
      throw new Error("boom");
    },
    setTimer: (_fn, ms) => {
      order.push(`setTimer:${ms}`);
      return {};
    },
  });
  assert.equal(res.armed, true);
  await new Promise((r) => setImmediate(r));
  assert.ok(order.some((e) => e.startsWith("setTimer:")), "the timer must be armed even when every explanatory write throws");
  assert.equal(
    order[0],
    `setTimer:${REFRESH_MARGIN_MS}`,
    "the reschedule must happen before any explanatory write is even attempted",
  );
});

test("W1-T1068: a successful mint reschedules on its own expiry as before", async () => {
  // THE RESTRUCTURE MUST NOT TOUCH THE HEALTHY PATH (rationale (0)): unchanged interval, unchanged
  // reason. Same assertions as the pre-existing "mints once and reschedules off the minted expiry"
  // case, re-asserted under this task's own acceptance criterion.
  const NOW = 1_700_000_000_000;
  const EXPIRES = NOW + 60 * 60 * 1000;
  let refreshes = 0;
  const delays: number[] = [];
  let unrefs = 0;
  const res = startInstallationTokenRefresh({
    log: () => {},
    env: { [GH_APP_ID_ENV]: "1", [GH_APP_INSTALLATION_ID_ENV]: "2", [GH_APP_PRIVATE_KEY_PATH_ENV]: "/k.pem" },
    refresh: async () => {
      refreshes += 1;
      return { ok: true, expiresAtMs: EXPIRES };
    },
    setTimer: (_fn, ms) => {
      delays.push(ms);
      return {
        unref: () => {
          unrefs += 1;
        },
      };
    },
    now: () => NOW,
  });
  assert.equal(res.armed, true);
  await new Promise((r) => setImmediate(r));
  assert.equal(refreshes, 1);
  assert.deepEqual(
    delays,
    [nextRefreshDelayMs(EXPIRES, NOW)],
    "a successful mint must keep rescheduling off its own expiry, unchanged by this task's restructure",
  );
  assert.equal(unrefs, 1, "an armed refresher must still never hold the process open");
});
