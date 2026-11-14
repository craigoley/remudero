import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EXCHANGE_TIMEOUT_MS,
  GH_APP_ID_ENV,
  GH_APP_INSTALLATION_ID_ENV,
  GH_APP_PRIVATE_KEY_PATH_ENV,
  INSTALLATION_TOKEN_LIFETIME_MS,
  REFRESH_FAILURE_RETRY_MS,
  TOKEN_REFRESHED_STEP,
  TOKEN_REFRESH_FAILED_STEP,
  refreshInstallationToken,
  startInstallationTokenRefresh,
} from "#src/lib/github-app.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

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

  // The 2026-11-10 outage, replayed through the production loop and the production key read. The daemon
  // (host 535a45bfa0c9, pid 155) minted at 11:59:01Z with a key read from ~/.claude/rmd-app.pem. From
  // 12:39:01Z every re-read of that file failed, so each refresh wrote "private key unreadable", although
  // the key in hand was still valid (serve, whose single-file mount kept the old file, minted at 12:57:22Z).
  // The file came back at 14:47:14Z (its mtime). Here the key file is deleted and never restored.
  await t.test("the 2026-11-10 private-key outage: a running loop keeps minting with the key it read", async (t) => {
    const minute = 60_000;
    let now = Date.parse("2026-11-10T11:59:01.583Z");
    const outageStart = Date.parse("2026-11-10T12:39:01.455Z");
    const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}app-key-outage-`));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const keyPath = join(dir, "rmd-app.pem");
    const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    writeFileSync(keyPath, pem, { mode: 0o600 });
    let minted = 0;
    const rows: Array<{ step: string; extra: Record<string, unknown>; at: number }> = [];
    const timers: Array<{ fn: () => void; delay: number; dueAt: number }> = [];
    const env: Record<string, string | undefined> = {
      [GH_APP_ID_ENV]: "1", [GH_APP_INSTALLATION_ID_ENV]: "2", [GH_APP_PRIVATE_KEY_PATH_ENV]: keyPath,
    };
    const fetchImpl = (async () => {
      minted++;
      return new Response(JSON.stringify({ token: `token-${minted}`, expires_at: new Date(now + INSTALLATION_TOKEN_LIFETIME_MS).toISOString() }), { status: 201 });
    }) as typeof fetch;
    const startLoop = () => startInstallationTokenRefresh({
      env,
      now: () => now,
      refresh: (o) => refreshInstallationToken({ ...o, now: () => now, fetchImpl }),
      log: (step, extra) => { rows.push({ step, extra: extra ?? {}, at: now }); },
      setTimer: (fn, delay) => {
        timers.push({ fn, delay, dueAt: now + delay });
        return {};
      },
      clearTimer: () => {},
    });
    const runUntil = async (end: number) => {
      let fires = 0;
      while (now < end && fires < 5_000) {
        const timer = timers.shift();
        assert.ok(timer, "the loop remains armed");
        now = Math.max(now, timer.dueAt);
        timer.fn();
        fires++;
        for (let i = 0; i < 50 && timers.length === 0; i++) await new Promise<void>((resolve) => setImmediate(resolve));
      }
      assert.ok(fires < 5_000, "the loop never spins");
    };
    const loop = startLoop();
    t.after(() => loop.stop?.());
    await loop.ready;
    assert.equal(env.GH_TOKEN, "token-1");
    now = outageStart;
    unlinkSync(keyPath);
    const end = outageStart + 6 * 60 * minute;
    await runUntil(end);
    const failed = rows.filter((row) => row.step === TOKEN_REFRESH_FAILED_STEP);
    assert.equal(failed.length, 0, "a key file that vanishes under a running loop writes no failure rows");
    const during = rows.filter((row) => row.step === TOKEN_REFRESHED_STEP && row.at >= outageStart);
    assert.ok(during.length >= 6, `the loop keeps renewing through the outage (${during.length} mints in 6 h)`);
    assert.ok(during.every((row) => row.extra.private_key === "retained" && row.extra.key_read_error === "ENOENT"),
      "each mint in the outage says it signed with the retained key and why the re-read failed");
    assert.equal(env.GH_TOKEN, `token-${minted}`, "the newest minted token is the one in use");
    assert.ok(timers[0]!.delay > REFRESH_FAILURE_RETRY_MS, "the loop stays on its healthy schedule");
    loop.stop?.();

    // A process that starts during the outage has no key to keep. It names the file error and stays bounded.
    timers.length = 0;
    rows.length = 0;
    const late = startLoop();
    t.after(() => late.stop?.());
    await late.ready;
    await runUntil(now + 60 * minute);
    const lateFailed = rows.filter((row) => row.step === TOKEN_REFRESH_FAILED_STEP);
    assert.ok(lateFailed.length > 0 && lateFailed.length <= 31, `a cold start writes ${lateFailed.length} rows in an hour, one per retry`);
    assert.ok(lateFailed.every((row) => row.extra.reason === "private key unreadable" && row.extra.error_code === "ENOENT"),
      "each row names the filesystem error, so the next outage has a cause on record");
  });
});
