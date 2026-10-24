import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { INSTALLATION_TOKEN_LIFETIME_MS, startInstallationTokenRefresh } from "#src/lib/github-app.js";
import { withManagedGardenTokenRefresh } from "#src/lib/managed-garden-token.js";
import { GARDENER_ORIGIN_ENV, gardenerOriginEnv } from "#src/lib/worker-containment.js";
import { runRegisteredGardenPass, type GardenBuildContext } from "#src/run-task.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const carrier = gardenerOriginEnv("review-replay", "a5142db1-3dab-4f50-8f8f-a25cfb8e8db1")!;
const keys = [GARDENER_ORIGIN_ENV, "GH_TOKEN", "GH_APP_ID", "GH_APP_INSTALLATION_ID", "GH_APP_PRIVATE_KEY_PATH"];
async function environment<T>(values: NodeJS.ProcessEnv, run: () => Promise<T>): Promise<T> {
  const saved = new Map(keys.map(key => [key, process.env[key]]));
  for (const key of keys) { if (values[key] === undefined) delete process.env[key]; else process.env[key] = values[key]; }
  try { return await run(); }
  finally { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
const managed = { [GARDENER_ORIGIN_ENV]: carrier, GH_TOKEN: "snapshot-test-token", GH_APP_ID: "1",
  GH_APP_INSTALLATION_ID: "2", GH_APP_PRIVATE_KEY_PATH: "unused-by-injected-exchange" };
const quiet = () => {};

// Uses the actual token manager and its timer callbacks, with a private clock and exchange.
test("a managed garden renews before work and again across inherited-token expiry", async () => {
  await environment(managed, async () => {
    let now = 0, mints = 0, clears = 0, unrefs = 0;
    let tick: (() => void) | undefined;
    let renewed!: () => void;
    const second = new Promise<void>(resolve => { renewed = resolve; });
    const start: typeof startInstallationTokenRefresh = options => startInstallationTokenRefresh({ ...options,
      now: () => now, setTimer: fn => { tick = fn; return { unref: () => { unrefs++; } }; }, clearTimer: () => { clears++; },
      refresh: async options => {
        assert.equal(options.env, process.env, "renewal updates the child's actual spawn environment");
        options.env!.GH_TOKEN = `renewed-test-token-${++mints}`;
        if (mints === 2) renewed();
        return { ok: true, expiresAtMs: now + INSTALLATION_TOKEN_LIFETIME_MS };
      } });
    const result = await withManagedGardenTokenRefresh("review-replay", quiet, async () => {
      assert.equal(process.env.GH_TOKEN, "renewed-test-token-1", "the first exchange precedes work");
      now = INSTALLATION_TOKEN_LIFETIME_MS + 1;
      assert.ok(tick);
      tick();
      await second;
      assert.equal(process.env.GH_TOKEN, "renewed-test-token-2", "publication sees the child's renewal");
      const credential = execFileSync("git", ["-c", "credential.helper=", "-c",
        'credential.helper=!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f', "credential", "fill"], {
        input: "protocol=https\nhost=example.invalid\n\n", encoding: "utf8",
        env: { PATH: process.env.PATH, GH_TOKEN: process.env.GH_TOKEN, GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
      });
      assert.match(credential, /^password=renewed-test-token-2$/m, "the real Git helper receives the renewed child environment");
      return 17;
    }, { start });
    assert.equal(result, 17);
    assert.equal(mints, 2);
    assert.equal(clears, 1);
    assert.ok(unrefs > 0, "the existing manager retains its non-blocking timer");
  });
});

test("managed token renewal preserves manual, malformed and foreign-garden credential contexts", async () => {
  for (const origin of [undefined, "not-json", gardenerOriginEnv("knowledge", "a5142db1-3dab-4f50-8f8f-a25cfb8e8db1")]) {
    await environment({ ...managed, [GARDENER_ORIGIN_ENV]: origin }, async () => {
      let ran = 0;
      const result = await withManagedGardenTokenRefresh("review-replay", quiet, async () => {
        ran++;
        assert.equal(process.env.GH_TOKEN, "snapshot-test-token");
        return 23;
      }, { start: () => { throw new Error("unmanaged credentials must not be replaced"); } });
      assert.equal(result, 23);
      assert.equal(ran, 1);
    });
  }
});

test("a managed garden without App configuration retains the actual default manager's no-op", async () => {
  await environment({ [GARDENER_ORIGIN_ENV]: carrier, GH_TOKEN: "snapshot-test-token" }, async () => {
    assert.equal(await withManagedGardenTokenRefresh("review-replay", quiet, async () => process.env.GH_TOKEN), "snapshot-test-token");
  });
});

test("managed renewal stops on pass rejection and on first-ready rejection", async () => {
  for (const early of [false, true]) await environment(managed, async () => {
    let stopped = 0, ran = 0;
    await assert.rejects(withManagedGardenTokenRefresh("review-replay", quiet, async () => {
      ran++;
      throw new Error("pass refused");
    }, { start: () => ({ armed: true, ready: early ? Promise.reject(new Error("first mint refused")) : Promise.resolve(), stop: () => { stopped++; } }) }),
    early ? /first mint refused/ : /pass refused/);
    assert.equal(ran, early ? 0 : 1);
    assert.equal(stopped, 1);
  });
});

test("a failed exchange retains the old token and existing retry policy during a managed pass", async () => {
  await environment(managed, async () => {
    let attempts = 0, retries = 0, stopped = 0;
    const start: typeof startInstallationTokenRefresh = options => startInstallationTokenRefresh({ ...options,
      refresh: async () => { attempts++; return { ok: false, reason: "exchange timed out" }; },
      setTimer: (_fn, delay) => { assert.ok(delay > 0); retries++; return {}; }, clearTimer: () => { stopped++; } });
    assert.equal(await withManagedGardenTokenRefresh("review-replay", quiet, async () => {
      assert.equal(process.env.GH_TOKEN, "snapshot-test-token");
      return 29;
    }, { start }), 29);
    assert.equal(attempts, 1);
    assert.equal(retries, 1);
    assert.equal(stopped, 1);
  });
});

test("the real registered garden refreshes inherited credentials before building and preserves domain failure", async t => {
  const repo = gitRepo({ scope: t }), key = join(repo.dir, "fake-app-key.pem");
  mkdirSync(join(repo.dir, "state"));
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(key, pair.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  for (const stopDuringMint of [false, true]) await environment({ ...managed, GH_APP_PRIVATE_KEY_PATH: key }, async () => {
    const signal = { stopped: false };
    const rows: Record<string, unknown>[] = [];
    let exchanges = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), "https://api.github.com/app/installations/2/access_tokens");
      assert.equal(init?.method, "POST");
      exchanges++;
      signal.stopped = stopDuringMint;
      return new Response(JSON.stringify({ token: "replacement-test-token", expires_at: new Date(Date.now() + INSTALLATION_TOKEN_LIFETIME_MS).toISOString() }), { status: 201 });
    };
    try {
      const ctx: GardenBuildContext = { config: { root: repo.dir, claudeBin: "/bin/true" } as GardenBuildContext["config"],
        repoRoot: repo.dir, owner: "acme", repo: "remudero", raiseDuplicate: () => { throw new Error("no external effect"); },
        log: (step, fields) => { assert.equal(process.env.GH_TOKEN, "replacement-test-token"); rows.push({ step, ...fields }); } };
      assert.equal(await runRegisteredGardenPass("review-replay", [], ctx, signal), stopDuringMint ? 0 : 1);
      assert.equal(exchanges, 1);
      assert.ok(rows.some(row => row.step === "github_app.token_refreshed"));
      assert.equal(rows.some(row => row.step === "review-replay.gardener_failed"), !stopDuringMint);
      assert.equal(JSON.stringify(rows).includes("replacement-test-token"), false, "credentials never enter log records");
    } finally { globalThis.fetch = originalFetch; }
  });
});

test("an already stopped registered garden starts no credential renewal", async t => {
  const repo = gitRepo({ scope: t });
  await environment(managed, async () => {
    const rows: string[] = [];
    const ctx: GardenBuildContext = { config: { root: repo.dir, claudeBin: "/bin/true" } as GardenBuildContext["config"],
      repoRoot: repo.dir, owner: "acme", repo: "remudero", log: step => rows.push(step), raiseDuplicate: () => "" };
    assert.equal(await runRegisteredGardenPass("review-replay", [], ctx, { stopped: true }), 0);
    assert.equal(process.env.GH_TOKEN, "snapshot-test-token");
    assert.deepEqual(rows, []);
  });
});
