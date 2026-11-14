import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  EXCHANGE_TIMEOUT_MS,
  GH_APP_ID_ENV,
  GH_APP_INSTALLATION_ID_ENV,
  GH_APP_PRIVATE_KEY_PATH_ENV,
  INSTALLATION_TOKEN_LIFETIME_MS,
  REFRESH_FAILURE_RETRY_MS,
  TOKEN_REFRESH_FAILED_STEP,
  refreshInstallationToken,
  startInstallationTokenRefresh,
} from "#src/lib/github-app.js";

test("W1-T12426: github_app.token_refresh_failed no longer recurs", async (t) => {
  for (const mode of ["returned", "rejected", "logger threw"] as const) {
    await t.test(mode, async (t) => {
      let now = 0;
      let expiresAtMs = INSTALLATION_TOKEN_LIFETIME_MS;
      let healthy = true;
      let attempts = 0;
      const rows: Array<{ step: string; reason: unknown }> = [];
      const timers: Array<{ fn: () => void; delay: number; dueAt: number }> = [];
      const env = {
        [GH_APP_ID_ENV]: "1",
        [GH_APP_INSTALLATION_ID_ENV]: "2",
        [GH_APP_PRIVATE_KEY_PATH_ENV]: "/unused.pem",
        GH_TOKEN: "retained-token",
      };
      const loop = startInstallationTokenRefresh({
        env,
        now: () => now,
        refresh: async () => {
          attempts++;
          if (healthy) return { ok: true, expiresAtMs };
          if (mode !== "returned") throw new Error("exchange unavailable");
          return { ok: false, reason: "exchange rejected: 503" };
        },
        log: (step, extra) => {
          if (mode === "logger threw") throw new Error("ledger unavailable");
          rows.push({ step, reason: extra?.reason });
        },
        setTimer: (fn, delay) => {
          timers.push({ fn, delay, dueAt: now + delay });
          return {};
        },
        clearTimer: () => {},
      });
      t.after(() => loop.stop?.());
      await loop.ready;
      assert.equal(loop.armed, true);
      assert.equal(timers.length, 1);
      const fire = async () => {
        const timer = timers.shift();
        assert.ok(timer, "the loop remains armed");
        now = Math.max(now, timer.dueAt);
        timer.fn();
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(timers.length, 1, "each attempt schedules exactly one successor");
      };
      healthy = false;
      // Cross the safe-start boundary while the retained token is still valid.
      now = expiresAtMs - EXCHANGE_TIMEOUT_MS;
      await fire();
      assert.equal(timers[0]!.delay, 0, "preserve one immediate retry");
      assert.ok(now < expiresAtMs, "the urgent retry occurs before the token expires");
      for (let i = 0; i < 4; i++) {
        await fire();
        assert.equal(timers[0]!.delay, REFRESH_FAILURE_RETRY_MS,
          "continued failure must not spin before or after token expiry");
      }
      assert.equal(attempts, 6);
      assert.ok(now > expiresAtMs, "the bounded cadence continues after expiry");
      assert.equal(env.GH_TOKEN, "retained-token", "failures preserve the existing credential");
      if (mode === "rejected") {
        assert.equal(rows.filter((row) => row.step === TOKEN_REFRESH_FAILED_STEP).length, 5,
          "each thrown failure is still reported rather than hidden");
        assert.ok(rows.some((row) => row.reason === "refresh threw: exchange unavailable"));
      }
      healthy = true;
      expiresAtMs = now + INSTALLATION_TOKEN_LIFETIME_MS;
      await fire();
      assert.ok(timers[0]!.delay > REFRESH_FAILURE_RETRY_MS, "recovery returns to healthy scheduling");
      healthy = false;
      now = expiresAtMs;
      await fire();
      assert.equal(timers[0]!.delay, 0, "a successful mint resets the immediate retry allowance");
      await fire();
      assert.equal(timers[0]!.delay, REFRESH_FAILURE_RETRY_MS);
    });
  }

  // The 2026-11-10 outage, replayed through the production refresh. The daemon (host 535a45bfa0c9, pid 155)
  // minted at 11:59:01Z. Its key read failed from 12:39:01Z until it minted again at 15:31:21Z. One archive
  // (ledger.2026-11-10T14-48-48-485Z) holds 22,848 "private key unreadable" rows from that pid, about 2 ms
  // apart: once the retained token passed its latest safe start, every failed attempt re-armed at 0 ms.
  // The bounded cadence leaves one row per REFRESH_FAILURE_RETRY_MS, and the loop recovers when the key does.
  await t.test("the 2026-11-10 private-key outage is bounded and recovers on its own", async (t) => {
    const minute = 60_000;
    let now = Date.parse("2026-11-10T11:59:01.583Z");
    const outageStart = Date.parse("2026-11-10T12:39:01.455Z");
    const outageEnd = Date.parse("2026-11-10T15:31:21.279Z");
    const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    let minted = 0;
    const mintedAt: number[] = [];
    const rows: Array<{ step: string; reason: unknown; at: number }> = [];
    const timers: Array<{ fn: () => void; delay: number; dueAt: number }> = [];
    const env: Record<string, string | undefined> = {
      [GH_APP_ID_ENV]: "1", [GH_APP_INSTALLATION_ID_ENV]: "2", [GH_APP_PRIVATE_KEY_PATH_ENV]: "/run/secrets/app.pem",
    };
    const fetchImpl = (async () => {
      minted++;
      mintedAt.push(now);
      return new Response(JSON.stringify({ token: `token-${minted}`, expires_at: new Date(now + INSTALLATION_TOKEN_LIFETIME_MS).toISOString() }), { status: 201 });
    }) as typeof fetch;
    const loop = startInstallationTokenRefresh({
      env,
      now: () => now,
      refresh: (o) => refreshInstallationToken({
        ...o, now: () => now, fetchImpl,
        readKey: () => {
          if (now >= outageStart && now < outageEnd) throw new Error("EACCES: permission denied");
          return pem;
        },
      }),
      log: (step, extra) => { rows.push({ step, reason: extra?.reason, at: now }); },
      setTimer: (fn, delay) => {
        timers.push({ fn, delay, dueAt: now + delay });
        return {};
      },
      clearTimer: () => {},
    });
    t.after(() => loop.stop?.());
    await loop.ready;
    assert.equal(env.GH_TOKEN, "token-1");
    let fires = 0;
    while (now < outageEnd + 30 * minute && fires < 5_000) {
      const timer = timers.shift();
      assert.ok(timer, "the loop remains armed");
      now = Math.max(now, timer.dueAt);
      timer.fn();
      fires++;
      for (let i = 0; i < 50 && timers.length === 0; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const failed = rows.filter((row) => row.step === TOKEN_REFRESH_FAILED_STEP);
    const bound = Math.ceil((outageEnd - outageStart) / REFRESH_FAILURE_RETRY_MS) + 2;
    assert.ok(failed.length > 0 && failed.length <= bound,
      `the outage writes ${failed.length} failure rows; at most ${bound} (one per ${REFRESH_FAILURE_RETRY_MS / minute} min), not one per attempt at 0 ms`);
    assert.ok(failed.every((row) => row.reason === "private key unreadable"), "every row names the real cause");
    assert.ok(failed.every((row) => row.at >= outageStart && row.at < outageEnd), "no failure row outside the outage");
    const gaps = failed.slice(1).map((row, i) => row.at - failed[i]!.at);
    assert.ok(gaps.filter((gap) => gap < REFRESH_FAILURE_RETRY_MS).length <= 2, `short gaps ${gaps.filter((gap) => gap < REFRESH_FAILURE_RETRY_MS)}: only the step to the latest safe start and one urgent retry`);
    assert.ok(fires < 5_000, "the loop never spins");
    assert.equal(env.GH_TOKEN, `token-${minted}`, "the first attempt after the key returns mints a fresh token");
    assert.ok(mintedAt.some((at) => at >= outageEnd && at < outageEnd + REFRESH_FAILURE_RETRY_MS + minute),
      "the loop recovers within one retry of the key returning, with no reset from the test");
    assert.ok(timers[0]!.delay > REFRESH_FAILURE_RETRY_MS, "after recovery the loop is back on its healthy schedule");
  });
});
