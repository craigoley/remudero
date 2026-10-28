// 2026-10-15, core daemon (pid 119, booted 03:40Z, token valid to 04:40:03Z): 17 consecutive
// github_app.token_refresh_failed "exchange timed out", 04:22:54Z-05:07:25Z, so the daemon ran ~27 min
// on a dead token. In the same window serve's own refresh succeeded (04:37:46Z), and the credential
// socket's worker thread minted 42 scoped tokens with no failure, so GitHub answered every time.
// The daemon's loop was held 60-190 s at a time by a synchronous spawn (daemon.loop_lag sync_spawn_ms
// 108-189 s, every ~2 min after the SRE lane started at 03:43Z). Node runs timers before I/O when a
// loop resumes, so the exchange's 20 s abort fired ahead of a response already in the socket.
// The deadline now counts loop-available time, the lead grows with the measured attempt cycle, and a
// token that nears or passes expiry with no replacement writes its own ledger row.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mock, test } from "node:test";
import * as appModule from "#src/lib/github-app.js";

const app = appModule as unknown as Record<string, any>;
const { EXCHANGE_TIMEOUT_MS, REFRESH_MARGIN_MS, INSTALLATION_TOKEN_LIFETIME_MS, GH_APP_ID_ENV, GH_APP_INSTALLATION_ID_ENV, GH_APP_PRIVATE_KEY_PATH_ENV } = appModule;

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});

/** A fetch that settles only when the test answers it, and rejects with the abort reason if aborted. */
function pendingFetch() {
  let answer: (r: Response) => void = () => {};
  let aborted = false;
  const fetchImpl = ((_url: string, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      answer = resolve;
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(init.signal!.reason);
      });
    })) as unknown as typeof fetch;
  const ok = (token: string): Response =>
    ({ ok: true, status: 201, json: async () => ({ token, expires_at: "2026-10-15T05:40:03Z" }) }) as Response;
  return { fetchImpl, respond: (token: string) => answer(ok(token)), wasAborted: () => aborted };
}

const settle = () => new Promise((r) => setImmediate(r));

test("an exchange whose response arrives as a stalled loop resumes is not aborted as timed out", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let clock = Date.parse("2026-10-15T04:20:03Z");
    const env: NodeJS.ProcessEnv = { GH_TOKEN: "old" };
    const exchange = pendingFetch();
    const logs: string[] = [];
    const promise = appModule.refreshInstallationToken({
      appId: "1", installationId: "155256285", privateKeyPath: "/k.pem", env, readKey: () => privateKey,
      fetchImpl: exchange.fetchImpl, now: () => clock, log: (step) => void logs.push(step),
    });
    await settle();
    // the loop was held 110 s by a sync spawn: the deadline timer fires 90 s late, before the I/O.
    clock += 110_000;
    mock.timers.tick(EXCHANGE_TIMEOUT_MS);
    assert.equal(exchange.wasAborted(), false, "a stall is not a spent budget");
    exchange.respond("fresh");
    const result = await promise;
    assert.equal(result.ok, true);
    assert.equal(env.GH_TOKEN, "fresh");
    assert.deepEqual(logs, ["github_app.token_refreshed"]);
  } finally {
    mock.timers.reset();
  }
});

test("a hung exchange is still abandoned once the loop has been free for the whole budget", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let clock = Date.parse("2026-10-15T04:20:03Z");
    const exchange = pendingFetch();
    const promise = appModule.refreshInstallationToken({
      appId: "1", installationId: "155256285", privateKeyPath: "/k.pem", env: {}, readKey: () => privateKey,
      fetchImpl: exchange.fetchImpl, now: () => clock, log: () => {},
    });
    await settle();
    clock += 110_000;
    mock.timers.tick(EXCHANGE_TIMEOUT_MS); // late: re-armed for the stalled time
    clock += EXCHANGE_TIMEOUT_MS;
    mock.timers.tick(EXCHANGE_TIMEOUT_MS); // on time: the budget is spent on a free loop
    const result = await promise;
    assert.equal(exchange.wasAborted(), true);
    assert.equal(result.reason, "exchange timed out");
  } finally {
    mock.timers.reset();
  }
});

test("the scoped mint the credential socket serves survives a stalled loop the same way", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let clock = Date.parse("2026-10-15T04:10:00Z");
    const exchange = pendingFetch();
    const promise = appModule.mintScopedToken("craigoley/remudero", 600_000, {
      appId: "1", installationId: "155256285", privateKeyPath: "/k.pem", env: {}, readKey: () => privateKey,
      fetchImpl: exchange.fetchImpl, now: () => clock, log: () => {},
    });
    await settle();
    clock += 69_000;
    mock.timers.tick(EXCHANGE_TIMEOUT_MS);
    exchange.respond("scoped");
    const minted = await promise;
    assert.equal(minted.ok, true);
    assert.equal(minted.token, "scoped");
  } finally {
    mock.timers.reset();
  }
});

test("the refresh lead grows with the measured attempt cycle and never past half the token's life", () => {
  assert.equal(typeof app.refreshLeadMs, "function");
  assert.equal(app.refreshLeadMs([]), REFRESH_MARGIN_MS, "a healthy loop keeps today's margin");
  assert.equal(app.refreshLeadMs([400]), REFRESH_MARGIN_MS);
  // 04:20:03Z due, 04:22:54Z settled: a 171 s cycle buys the margin's attempt count at that cost.
  const slow = app.refreshLeadMs([400, 171_000]);
  assert.ok(slow > REFRESH_MARGIN_MS, `lead ${slow} must exceed the fixed margin`);
  assert.ok(slow <= INSTALLATION_TOKEN_LIFETIME_MS / 2);
  assert.equal(app.refreshLeadMs([10 * 60_000]), INSTALLATION_TOKEN_LIFETIME_MS / 2);
  assert.equal(app.nextRefreshDelayMs(1_000_000_000, 0, slow), 1_000_000_000 - slow);
});

test("the refresh loop schedules off the lead its own measured cycles give", async () => {
  let now = Date.parse("2026-10-15T03:40:03Z");
  const delays: number[] = [];
  const expiresAt = now + 171_000 + INSTALLATION_TOKEN_LIFETIME_MS;
  const res = appModule.startInstallationTokenRefresh({
    log: () => {},
    env: { [GH_APP_ID_ENV]: "1", [GH_APP_INSTALLATION_ID_ENV]: "2", [GH_APP_PRIVATE_KEY_PATH_ENV]: "/k.pem" },
    refresh: async () => {
      now += 171_000; // a mint that took 171 s of wall time, stalls included
      return { ok: true, expiresAtMs: expiresAt };
    },
    setTimer: (_fn, ms) => {
      delays.push(ms);
      return {};
    },
    now: () => now,
  });
  await res.ready;
  assert.equal(delays.length, 1);
  assert.equal(delays[0], expiresAt - app.refreshLeadMs([171_000]) - now);
  assert.ok(delays[0]! < expiresAt - REFRESH_MARGIN_MS - now, "refreshes earlier than the fixed margin would");
});

test("a failing refresh writes token_expiring once past half its lead and token_expired once the token is dead", async () => {
  const minted = Date.parse("2026-10-15T03:40:03Z");
  const expiresAt = minted + INSTALLATION_TOKEN_LIFETIME_MS;
  let now = minted;
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const timers: Array<() => void> = [];
  let ok = true;
  const res = appModule.startInstallationTokenRefresh({
    log: (step, extra = {}) => void rows.push({ step, extra }),
    env: { [GH_APP_ID_ENV]: "1", [GH_APP_INSTALLATION_ID_ENV]: "2", [GH_APP_PRIVATE_KEY_PATH_ENV]: "/k.pem" },
    refresh: async () => (ok ? { ok: true, expiresAtMs: expiresAt } : { ok: false, reason: "exchange timed out" }),
    setTimer: (fn) => {
      timers.push(fn);
      return {};
    },
    now: () => now,
  });
  await res.ready;
  ok = false;
  const failAt = async (iso: string) => {
    now = Date.parse(iso);
    timers.at(-1)!();
    await settle();
  };
  const warnings = () => rows.filter((r) => r.step === "github_app.token_expiring" || r.step === "github_app.token_expired");

  await failAt("2026-10-15T04:22:54Z"); // 17 min left, more than half the (measured) lead: not yet near
  assert.deepEqual(warnings(), []);
  await failAt("2026-10-15T04:31:11Z"); // under half the lead left
  await failAt("2026-10-15T04:35:38Z");
  assert.deepEqual(warnings().map((r) => r.step), ["github_app.token_expiring"], "written once per retained token");
  const expiring = warnings()[0]!.extra;
  assert.equal(expiring.expires_at, new Date(expiresAt).toISOString());
  assert.equal(expiring.failed_attempts, 2);
  assert.equal(expiring.last_reason, "exchange timed out");
  assert.ok(Number(expiring.remaining_ms) > 0 && Number(expiring.remaining_ms) < REFRESH_MARGIN_MS / 2);

  await failAt("2026-10-15T04:43:07Z"); // the token is dead
  await failAt("2026-10-15T04:45:13Z");
  assert.deepEqual(warnings().map((r) => r.step), ["github_app.token_expiring", "github_app.token_expired"]);
  assert.ok(Number(warnings()[1]!.extra.remaining_ms) < 0);
  assert.equal(warnings()[1]!.extra.failed_attempts, 4);
});
