import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  GH_APP_ID_ENV, GH_APP_INSTALLATION_ID_ENV, GH_APP_PRIVATE_KEY_PATH_ENV, INSTALLATION_TOKEN_LIFETIME_MS,
  startInstallationTokenRefresh, type InstallationTokenResult,
} from "#src/lib/github-app.js";
import {
  ensureGardenTokenFresh, GARDEN_TOKEN_EXPIRED, mintInstallationTokenSync, refuseExpiredGardenToken, withManagedGardenTokenRefresh,
  type SyncExchangeSpawn,
} from "#src/lib/managed-garden-token.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ciFrictionHandFixRun, ghCiFrictionEscalationIssues, readCiFrictionHandFixes } from "#src/lib/ci-friction-gardener.js";
import { GARDENER_ORIGIN_ENV, gardenerOriginEnv } from "#src/lib/worker-containment.js";
import { clockFromMillisFn, fixedClock } from "#src/lib/clock.js";

const SPAWN_TOKEN = "spawn-test-token-aaaa";
const RENEWED_TOKEN = "renewed-test-token-bbbb";
const KEY_TEXT = "-----BEGIN TEST KEY-----not-a-real-key-----END TEST KEY-----";
const carrier = gardenerOriginEnv("ci-friction", "a5142db1-3dab-4f50-8f8f-a25cfb8e8db1")!;
const keys = [GARDENER_ORIGIN_ENV, "GH_TOKEN", GH_APP_ID_ENV, GH_APP_INSTALLATION_ID_ENV, GH_APP_PRIVATE_KEY_PATH_ENV];
const managed = { [GARDENER_ORIGIN_ENV]: carrier, GH_TOKEN: "inherited-test-token", [GH_APP_ID_ENV]: "1",
  [GH_APP_INSTALLATION_ID_ENV]: "2", [GH_APP_PRIVATE_KEY_PATH_ENV]: "/nonexistent/test-app-key.pem" };

async function environment<T>(values: NodeJS.ProcessEnv, run: () => Promise<T>): Promise<T> {
  const saved = new Map(keys.map(key => [key, process.env[key]]));
  for (const key of keys) { if (values[key] === undefined) delete process.env[key]; else process.env[key] = values[key]; }
  try { return await run(); }
  finally { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

/** A managed pass driven by the real refresh loop: its first mint expires at `expiry`; `mintSync` answers a renewal. */
function pass(clock: { now: number }, rows: Array<{ step: string; extra?: Record<string, unknown> }>,
  mintSync: () => InstallationTokenResult, counts: { syncMints: number }) {
  const start: typeof startInstallationTokenRefresh = options => startInstallationTokenRefresh({ ...options,
    now: () => clock.now, setTimer: () => ({ unref: () => {} }), clearTimer: () => {},
    refresh: async o => { o.env!.GH_TOKEN = SPAWN_TOKEN; return { ok: true, expiresAtMs: INSTALLATION_TOKEN_LIFETIME_MS }; },
    mintSync: () => { counts.syncMints++; return mintSync(); } });
  const log = (step: string, extra?: Record<string, unknown>) => { rows.push({ step, extra }); };
  return <T>(run: () => Promise<T>) => withManagedGardenTokenRefresh("ci-friction", log, run, { start, clock: clockFromMillisFn(() => clock.now) });
}

test("W1-T14623 criterion 1: past the held token's expiry a gh call presents a renewed token, or is refused and never spawned", async () => {
  await environment(managed, async () => {
    const clock = { now: 0 };
    const counts = { syncMints: 0 };
    const seen: Array<string | undefined> = [];
    const gh = ciFrictionHandFixRun("/nonexistent", () => { seen.push(process.env.GH_TOKEN); return "[]"; });

    await pass(clock, [], () => ({ ok: true, token: RENEWED_TOKEN, expiresAtMs: 2 * INSTALLATION_TOKEN_LIFETIME_MS }), counts)(async () => {
      clock.now = INSTALLATION_TOKEN_LIFETIME_MS + 1; // the loop was blocked; the timer never fired
      assert.equal(gh("gh", ["api", "rate_limit"]), "[]");
      assert.deepEqual(seen, [RENEWED_TOKEN], "the spawn reads the renewed token, not the expired one");
      assert.equal(counts.syncMints, 1);
      assert.deepEqual(ensureGardenTokenFresh(), { state: "fresh" }, "the renewal's expiry now governs");
    });

    seen.length = 0;
    clock.now = 0;
    await pass(clock, [], () => ({ ok: false, reason: "exchange rejected: 500" }), counts)(async () => {
      clock.now = INSTALLATION_TOKEN_LIFETIME_MS + 1;
      assert.throws(() => gh("gh", ["api", "rate_limit"]), new RegExp(`^Error: ${GARDEN_TOKEN_EXPIRED}: .*exchange rejected: 500`));
      assert.deepEqual(seen, [], "a refused call is never spawned");
      const issues = ghCiFrictionEscalationIssues();
      await assert.rejects(async () => issues.listComments("https://github.com/o/r/issues/1"), new RegExp(`^Error: ${GARDEN_TOKEN_EXPIRED}`),
        "the default release transport refuses too, before any spawn");
    });
  });
});

test("W1-T14623 criterion 2: a call while the held token is unexpired is unchanged and mints nothing", async () => {
  await environment(managed, async () => {
    const clock = { now: 0 };
    const counts = { syncMints: 0 };
    const seen: Array<string | undefined> = [];
    const gh = ciFrictionHandFixRun("/nonexistent", () => { seen.push(process.env.GH_TOKEN); return "ok"; });
    await pass(clock, [], () => { throw new Error("an unexpired token must not be renewed"); }, counts)(async () => {
      clock.now = INSTALLATION_TOKEN_LIFETIME_MS - 1;
      assert.equal(gh("gh", ["api", "rate_limit"]), "ok");
      assert.deepEqual(ensureGardenTokenFresh(), { state: "fresh" });
    });
    assert.deepEqual(seen, [SPAWN_TOKEN]);
    assert.equal(counts.syncMints, 0);
    // Outside a managed pass nothing is known about the token: the call proceeds exactly as before.
    assert.deepEqual(ensureGardenTokenFresh(), { state: "unmanaged" });
    assert.doesNotThrow(() => refuseExpiredGardenToken());
    assert.equal(ciFrictionHandFixRun(process.cwd())("git", ["rev-parse", "--is-inside-work-tree"]).trim(), "true",
      "a non-gh command keeps its direct spawn");
  });
});

test("W1-T14623 criterion 3: ci-friction.hand_fixes_unmeasured names token_expired, not a bare gh 401", async () => {
  await environment(managed, async () => {
    const clock = { now: 0 };
    const state = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14623-`));
    try {
      await pass(clock, [], () => ({ ok: false, reason: "exchange timed out" }), { syncMints: 0 })(async () => {
        clock.now = INSTALLATION_TOKEN_LIFETIME_MS + 5;
        const read = readCiFrictionHandFixes("/nonexistent", state, "o", "r", fixedClock(Date.parse("2026-11-24T06:52:28Z")),
          ciFrictionHandFixRun("/nonexistent", () => { throw new Error("gh: Bad credentials (HTTP 401)"); }), () => "a".repeat(40));
        assert.equal(read.state, "unmeasured");
        assert.ok(read.state === "unmeasured" && read.reason.startsWith(`${GARDEN_TOKEN_EXPIRED}:`), `reason: ${JSON.stringify(read)}`);
        assert.doesNotMatch(read.state === "unmeasured" ? read.reason : "", /401/);
      });
    } finally { rmSync(state, { recursive: true, force: true }); }
  });
});

test("W1-T14623 criterion 4: invariant:no-secret-in-a-row — no token or key reaches a row, a log line or argv", async () => {
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const spawned: Array<{ file: string; args: readonly string[]; env: NodeJS.ProcessEnv; input: string }> = [];
  const fake = (stdout: string): SyncExchangeSpawn => (file, args, opts) => { spawned.push({ file, args, env: opts.env, input: opts.input }); return { stdout, error: undefined }; };
  const config = { appId: "1", installationId: "2", privateKeyPath: "/k.pem" };
  const { generateKeyPairSync } = await import("node:crypto");
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const log = (step: string, extra?: Record<string, unknown>) => { rows.push({ step, extra }); };
  const ok = mintInstallationTokenSync(config, { readKey: () => pem, log,
    spawn: fake(JSON.stringify({ token: RENEWED_TOKEN, expires_at: "2026-11-24T08:00:00Z" })) });
  assert.deepEqual(ok, { ok: true, token: RENEWED_TOKEN, expiresAtMs: Date.parse("2026-11-24T08:00:00Z") });
  const outcomes: Array<[string, string]> = [
    [JSON.stringify({ status: 401 }), "exchange rejected: 401"],
    [JSON.stringify({ error: "ECONNRESET" }), "exchange request failed: ECONNRESET"],
    [JSON.stringify({ error: "TimeoutError" }), "exchange timed out"],
    [JSON.stringify({ token: "" }), "exchange response missing token"],
    ["not json", "exchange response unparsable"],
  ];
  for (const [stdout, reason] of outcomes) assert.equal(mintInstallationTokenSync(config, { readKey: () => pem, log, spawn: fake(stdout) }).reason, reason);
  assert.equal(mintInstallationTokenSync(config, { readKey: () => pem, log, spawn: () => ({ stdout: "", error: new Error("ETIMEDOUT") }) }).reason, "exchange timed out");
  assert.equal(mintInstallationTokenSync(config, { readKey: () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); }, log }).reason, "private key unreadable");
  const retained = { pem };
  assert.equal(mintInstallationTokenSync(config, { readKey: () => { throw new Error("gone"); }, retainedKey: retained, log, spawn: fake("x") }).reason,
    "exchange response unparsable", "a retained key still signs after a failed re-read");
  assert.equal(mintInstallationTokenSync(config, { readKey: () => KEY_TEXT, log }).reason, "jwt signing failed");
  assert.equal(mintInstallationTokenSync({ appId: "", installationId: "", privateKeyPath: "" }).reason, "app not configured");
  const undatedExpiry = mintInstallationTokenSync(config, { readKey: () => pem, now: () => 1_000, spawn: fake(JSON.stringify({ token: RENEWED_TOKEN, expires_at: "soon" })) });
  assert.equal(undatedExpiry.expiresAtMs, 1_000 + INSTALLATION_TOKEN_LIFETIME_MS);

  for (const call of spawned) {
    assert.equal(call.file, process.execPath);
    assert.ok(!call.args.join(" ").includes(RENEWED_TOKEN) && !call.args.join(" ").includes("PRIVATE KEY"), "argv holds no secret");
    assert.equal(call.env.NODE_OPTIONS, undefined, "the exchange child loads no inherited loader");
    const input = JSON.parse(call.input) as { url: string; jwt: string; timeoutMs: number };
    assert.equal(input.url, "https://api.github.com/app/installations/2/access_tokens");
    assert.match(input.jwt, /^eyJ/, "the JWT travels on stdin");
    assert.ok(!JSON.stringify(call.env).includes(input.jwt) && !call.args.join(" ").includes(input.jwt), "never in env or argv");
  }
  const text = JSON.stringify(rows);
  assert.ok(!text.includes(RENEWED_TOKEN) && !text.includes("PRIVATE KEY") && !text.includes("eyJ"), `rows leak nothing: ${text}`);
  assert.ok(rows.every(row => row.extra?.mode === "sync"));

  // The real default spawn: a child that cannot reach its exchange reports a named reason, never a token.
  const live = mintInstallationTokenSync(config, { readKey: () => pem, apiUrl: "http://127.0.0.1:9", log });
  assert.equal(live.ok, false);
  assert.match(live.reason ?? "", /^exchange (request failed: |timed out)/);
});

test("W1-T14623: renewSync on the real loop writes GH_TOKEN only on success and keeps the old one on failure", async () => {
  const env: Record<string, string | undefined> = { [GH_APP_ID_ENV]: "1", [GH_APP_INSTALLATION_ID_ENV]: "2", [GH_APP_PRIVATE_KEY_PATH_ENV]: "/k", GH_TOKEN: "old" };
  let answer: InstallationTokenResult = { ok: false, reason: "exchange timed out" };
  const loop = startInstallationTokenRefresh({ log: () => {}, env, now: () => 0, setTimer: () => ({}), clearTimer: () => {},
    refresh: async () => ({ ok: false, reason: "exchange timed out" }), mintSync: () => answer });
  await loop.ready;
  assert.equal(loop.expiresAtMs?.(), undefined);
  assert.deepEqual(loop.renewSync?.(), { ok: false, reason: "exchange timed out" });
  assert.equal(env.GH_TOKEN, "old");
  answer = { ok: true };
  assert.deepEqual(loop.renewSync?.(), { ok: false, reason: "exchange response missing token" }, "a success with no token is not a renewal");
  answer = { ok: true, token: "new", expiresAtMs: 99 };
  assert.deepEqual(loop.renewSync?.(), { ok: true, expiresAtMs: 99 });
  assert.equal(env.GH_TOKEN, "new");
  assert.equal(loop.expiresAtMs?.(), 99);
  loop.stop?.();
  // Without an injected exchange the loop offers no blocking renewal, and a managed pass reads it as unmanaged.
  const plain = startInstallationTokenRefresh({ log: () => {}, env: { ...env }, setTimer: () => ({}), clearTimer: () => {},
    refresh: async () => ({ ok: true, expiresAtMs: 1 }) });
  await plain.ready;
  assert.equal(plain.renewSync, undefined);
  plain.stop?.();
});
