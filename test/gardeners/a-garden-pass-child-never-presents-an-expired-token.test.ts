import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  GH_APP_ID_ENV, GH_APP_INSTALLATION_ID_ENV, GH_APP_PRIVATE_KEY_PATH_ENV, INSTALLATION_TOKEN_LIFETIME_MS,
  startInstallationTokenRefresh, type RefreshResult,
} from "#src/lib/github-app.js";
import {
  GARDEN_TOKEN_EXPIRED, gardenTokenState, refuseExpiredGardenToken, renewExpiredGardenToken, withManagedGardenTokenRefresh,
} from "#src/lib/managed-garden-token.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ciFrictionReleaseGh, ghCiFrictionEscalationIssues, readCiFrictionHandFixes } from "#src/lib/ci-friction-gardener.js";
import { GARDENER_ORIGIN_ENV, gardenerOriginEnv } from "#src/lib/worker-containment.js";
import { clockFromMillisFn, fixedClock } from "#src/lib/clock.js";

const SPAWN_TOKEN = "spawn-test-token-aaaa";
const RENEWED_TOKEN = "renewed-test-token-bbbb";
const carrier = gardenerOriginEnv("ci-friction", "a5142db1-3dab-4f50-8f8f-a25cfb8e8db1")!;
const keys = [GARDENER_ORIGIN_ENV, "GH_TOKEN", "GH_CONFIG_DIR", "GITHUB_TOKEN", GH_APP_ID_ENV, GH_APP_INSTALLATION_ID_ENV, GH_APP_PRIVATE_KEY_PATH_ENV];
const managed = { [GARDENER_ORIGIN_ENV]: carrier, GH_TOKEN: "inherited-test-token", [GH_APP_ID_ENV]: "1",
  [GH_APP_INSTALLATION_ID_ENV]: "2", [GH_APP_PRIVATE_KEY_PATH_ENV]: "/nonexistent/test-app-key.pem" };
const MAIN_SHA = "a".repeat(40);
const AT = fixedClock(Date.parse("2026-11-24T06:52:28Z"));

async function environment<T>(values: NodeJS.ProcessEnv, run: () => Promise<T>): Promise<T> {
  const saved = new Map(keys.map(key => [key, process.env[key]]));
  for (const key of keys) { if (values[key] === undefined) delete process.env[key]; else process.env[key] = values[key]; }
  try { return await run(); }
  finally { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

type Row = { step: string; extra?: Record<string, unknown> };

/** A managed pass on the real refresh loop whose timer never fires (its loop is blocked): the first mint expires at
 *  one token lifetime, and `renewal` answers every later refresh. */
function pass(clock: { now: number }, rows: Row[], renewal: () => RefreshResult & { token?: string }, counts: { mints: number }) {
  const start: typeof startInstallationTokenRefresh = options => startInstallationTokenRefresh({ ...options,
    now: () => clock.now, setTimer: () => ({ unref: () => {} }), clearTimer: () => {},
    refresh: async o => {
      counts.mints++;
      if (counts.mints === 1) { o.env!.GH_TOKEN = SPAWN_TOKEN; return { ok: true, expiresAtMs: INSTALLATION_TOKEN_LIFETIME_MS }; }
      const { token, ...result } = renewal();
      if (result.ok && token) o.env!.GH_TOKEN = token;
      return result;
    } });
  const log = (step: string, extra?: Record<string, unknown>) => { rows.push({ step, extra }); };
  return <T>(run: () => Promise<T>) => withManagedGardenTokenRefresh("ci-friction", log, run, { start, clock: clockFromMillisFn(() => clock.now) });
}

function withState<T>(run: (state: string) => Promise<T>): Promise<T> {
  const state = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14623-`));
  return run(state).finally(() => rmSync(state, { recursive: true, force: true }));
}

test("W1-T14623 criterion 1: past the held token's expiry a gh call presents a renewed token, or is refused and never spawned", async () => {
  await environment(managed, async () => {
    const clock = { now: 0 };
    const counts = { mints: 0 };
    const seen: Array<string | undefined> = [];
    const gh = async (_args: string[]) => { seen.push(process.env.GH_TOKEN); return "[]"; };

    await pass(clock, [], () => ({ ok: true, token: RENEWED_TOKEN, expiresAtMs: 2 * INSTALLATION_TOKEN_LIFETIME_MS }), counts)(async () => {
      clock.now = INSTALLATION_TOKEN_LIFETIME_MS + 1; // the loop was blocked; the timer never fired
      assert.deepEqual(gardenTokenState().state, "expired");
      assert.equal(await ciFrictionReleaseGh(["api", "rate_limit"], gh), "[]");
      assert.deepEqual(seen, [RENEWED_TOKEN], "the awaited call reads the renewed token, not the expired one");
      assert.equal(counts.mints, 2);
      assert.deepEqual(gardenTokenState(), { state: "fresh" }, "the renewal's expiry now governs");
    });

    seen.length = 0;
    clock.now = 0;
    await pass(clock, [], () => ({ ok: false, reason: "exchange rejected: 500" }), { mints: 0 })(async () => {
      clock.now = INSTALLATION_TOKEN_LIFETIME_MS + 1;
      await assert.rejects(async () => ciFrictionReleaseGh(["api", "rate_limit"], gh), new RegExp(`^Error: ${GARDEN_TOKEN_EXPIRED}: .*exchange rejected: 500`));
      const issues = ghCiFrictionEscalationIssues();
      await assert.rejects(async () => issues.listComments("https://github.com/o/r/issues/1"), new RegExp(`^Error: ${GARDEN_TOKEN_EXPIRED}`),
        "the default release transport refuses too, before any spawn");
      // A synchronous call cannot renew without blocking the loop: it is refused, and its gh is never spawned.
      assert.throws(() => refuseExpiredGardenToken(), new RegExp(`^Error: ${GARDEN_TOKEN_EXPIRED}: `));
      await withState(async state => {
        const read = readCiFrictionHandFixes("/nonexistent", state, "o", "r", AT, undefined, () => MAIN_SHA);
        assert.equal(read.state, "unmeasured", "the default spawn never ran: /nonexistent would have failed differently");
      });
    });
    assert.deepEqual(seen, [], "a refused call is never spawned");
  });
});

test("W1-T14623 criterion 2: a call while the held token is unexpired is unchanged and mints nothing", async () => {
  await environment(managed, async () => {
    const clock = { now: 0 };
    const counts = { mints: 0 };
    const seen: Array<string | undefined> = [];
    await pass(clock, [], () => { throw new Error("an unexpired token must not be renewed"); }, counts)(async () => {
      clock.now = INSTALLATION_TOKEN_LIFETIME_MS - 1;
      assert.equal(await ciFrictionReleaseGh(["api", "rate_limit"], async () => { seen.push(process.env.GH_TOKEN); return "ok"; }), "ok");
      assert.doesNotThrow(() => refuseExpiredGardenToken());
      assert.deepEqual(await renewExpiredGardenToken(), { state: "fresh" });
    });
    assert.deepEqual(seen, [SPAWN_TOKEN]);
    assert.equal(counts.mints, 1, "only the pass's first mint");
    // Outside a managed pass nothing is known about the token: the call proceeds exactly as before.
    assert.deepEqual(gardenTokenState(), { state: "unmanaged" });
    assert.deepEqual(await renewExpiredGardenToken(), { state: "unmanaged" });
    assert.doesNotThrow(() => refuseExpiredGardenToken());
  });
});

test("W1-T14623 criterion 3: ci-friction.hand_fixes_unmeasured names token_expired, not a bare gh 401", async () => {
  await environment(managed, async () => {
    const clock = { now: 0 };
    await withState(async state => pass(clock, [], () => ({ ok: false, reason: "exchange timed out" }), { mints: 0 })(async () => {
      clock.now = INSTALLATION_TOKEN_LIFETIME_MS + 5;
      const read = readCiFrictionHandFixes("/nonexistent", state, "o", "r", AT, undefined, () => MAIN_SHA);
      assert.equal(read.state, "unmeasured");
      assert.ok(read.state === "unmeasured" && read.reason.startsWith(`${GARDEN_TOKEN_EXPIRED}:`), `reason: ${JSON.stringify(read)}`);
      assert.doesNotMatch(read.state === "unmeasured" ? read.reason : "", /401/);
    }));
  });
});

test("W1-T14623 criterion 4: invariant:no-secret-in-a-row — no token or key reaches a row, a log line or argv", async () => {
  await environment(managed, async () => {
    const clock = { now: 0 };
    const rows: Row[] = [];
    const argv: string[][] = [];
    const messages: string[] = [];
    let answer: RefreshResult & { token?: string } = { ok: false, reason: "exchange rejected: 401" };
    await pass(clock, rows, () => answer, { mints: 0 })(async () => {
      clock.now = INSTALLATION_TOKEN_LIFETIME_MS + 1;
      await ciFrictionReleaseGh(["api", "rate_limit"], async a => { argv.push(a); return ""; }).catch((e: Error) => { messages.push(e.message); });
      try { refuseExpiredGardenToken(); } catch (e) { messages.push((e as Error).message); }
      answer = { ok: true, token: RENEWED_TOKEN, expiresAtMs: 2 * INSTALLATION_TOKEN_LIFETIME_MS };
      await ciFrictionReleaseGh(["api", "rate_limit"], async a => { argv.push(a); return ""; });
    });
    assert.equal(messages.length, 2);
    assert.deepEqual(argv, [["api", "rate_limit"]], "the token travels in GH_TOKEN, never argv");
    const text = JSON.stringify({ rows, argv, messages });
    for (const secret of [SPAWN_TOKEN, RENEWED_TOKEN, "inherited-test-token", "PRIVATE KEY"]) assert.ok(!text.includes(secret), `${secret} leaked: ${text}`);
  });
});

test("W1-T14623: the hand-fix read's default gh spawn still runs while the token is not known to be dead", async () => {
  await withState(async state => {
    const config = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14623-gh-`));
    try {
      // Unmanaged, with no credential at all: the real gh runs and fails, and the read names gh's failure, not a refusal.
      await environment({ GH_CONFIG_DIR: config }, async () => {
        const read = readCiFrictionHandFixes(process.cwd(), state, "o", "r", AT, undefined, () => MAIN_SHA);
        assert.equal(read.state, "unmeasured");
        assert.ok(read.state === "unmeasured" && !read.reason.startsWith(GARDEN_TOKEN_EXPIRED), `reason: ${JSON.stringify(read)}`);
      });
    } finally { rmSync(config, { recursive: true, force: true }); }
  });
});

test("W1-T14623: renewNow on the real loop writes GH_TOKEN only on success and re-arms its timer", async () => {
  const env: Record<string, string | undefined> = { [GH_APP_ID_ENV]: "1", [GH_APP_INSTALLATION_ID_ENV]: "2", [GH_APP_PRIVATE_KEY_PATH_ENV]: "/k", GH_TOKEN: "old" };
  let answer: RefreshResult & { token?: string } = { ok: false, reason: "exchange timed out" };
  const armed: number[] = [];
  const cleared: number[] = [];
  const loop = startInstallationTokenRefresh({ log: () => {}, env, now: () => 0, setTimer: (_fn, ms) => { armed.push(ms); return {}; },
    clearTimer: () => { cleared.push(armed.length); },
    refresh: async o => { const { token, ...result } = answer; if (result.ok && token) o.env!.GH_TOKEN = token; return result; } });
  await loop.ready;
  assert.equal(loop.expiresAtMs?.(), undefined);
  assert.deepEqual(await loop.renewNow?.(), { ok: false, reason: "exchange timed out" });
  assert.equal(env.GH_TOKEN, "old");
  answer = { ok: true, token: "new", expiresAtMs: INSTALLATION_TOKEN_LIFETIME_MS };
  assert.deepEqual(await loop.renewNow?.(), { ok: true, expiresAtMs: INSTALLATION_TOKEN_LIFETIME_MS });
  assert.equal(env.GH_TOKEN, "new");
  assert.equal(loop.expiresAtMs?.(), INSTALLATION_TOKEN_LIFETIME_MS);
  assert.equal(cleared.length, 2, "each renewal clears the pending timer before it re-arms");
  assert.equal(armed.length, 3);
  loop.stop?.();
  assert.equal(startInstallationTokenRefresh({ log: () => {}, env: {} }).renewNow, undefined, "an unarmed loop offers no renewal");
});
