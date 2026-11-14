import assert from "node:assert/strict";
import test from "node:test";
import {
  EXCHANGE_TIMEOUT_MS,
  GH_APP_ID_ENV,
  GH_APP_INSTALLATION_ID_ENV,
  GH_APP_PRIVATE_KEY_PATH_ENV,
  INSTALLATION_TOKEN_LIFETIME_MS,
  REFRESH_FAILURE_RETRY_MS,
  TOKEN_REFRESH_FAILED_STEP,
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
});
