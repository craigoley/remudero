// W1-T14623: a ci-friction garden pass ran about 60 minutes; its hand-fix read at the end spawned gh with the App token
// minted at the pass's start, and read HTTP 401. The pass's loop was blocked by synchronous gh calls, so its renewal
// timer never fired. Now the managed garden wrapper installs W1-T14543's held-token guard: past expiry an awaited gh
// call renews first (or is refused with token_expired), and a synchronous one is refused before it is spawned.
//
// FIXTURES ONLY: an injected refresh minting made-up tokens, an injected clock, timers that never fire (the blocked
// loop), and the shared PATH-shim gh that prints the GH_TOKEN it was spawned with. No network.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { clockFromMillisFn, fixedClock } from "#src/lib/clock.js";
import { startInstallationTokenRefresh, type RefreshOptions, type RefreshResult } from "#src/lib/github-app.js";
import { ghTextAsync } from "#src/lib/github-transport.js";
import { withManagedGardenTokenRefresh } from "#src/lib/managed-garden-token.js";
import { ghCiFrictionEscalationIssues, readCiFrictionHandFixes } from "#src/lib/ci-friction-gardener.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { GARDENER_ORIGIN_ENV, gardenerOriginEnv } from "#src/lib/worker-containment.js";
import { ghShim, type GhShim } from "#test/helpers/gh-shim.js";

const HOUR_MS = 60 * 60 * 1000;
const STARTED_AT = Date.parse("2026-11-24T05:52:20.000Z");
const ENV_NAMES = [GARDENER_ORIGIN_ENV, "GH_APP_ID", "GH_APP_INSTALLATION_ID", "GH_APP_PRIVATE_KEY_PATH", "GH_TOKEN", "GITHUB_TOKEN", "PATH", "RMD_GH_SHARED_READ_GAP_MS"];
const READ_ARGS = ["api", "repos/acme/t14623-widgets/issues/1/comments"];

interface Harness {
  set(ms: number): void;
  tokens: string[];
  rows: Array<{ step: string; fields?: Record<string, unknown> }>;
  failures: number;
  attempts: number;
  shim: GhShim;
  pass<T>(name: string, run: () => Promise<T>): Promise<T>;
}

function harness(t: TestContext): Harness {
  const saved = new Map(ENV_NAMES.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const shim = ghShim([{ when: "repos/acme/t14623", stdoutEnv: "GH_TOKEN" }], { kind: "t14623-gh" });
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  process.env[GARDENER_ORIGIN_ENV] = gardenerOriginEnv("ci-friction", "a5142db1-3dab-4f50-8f8f-a25cfb8e8db1")!;
  process.env.GH_APP_ID = "424242";
  process.env.GH_APP_INSTALLATION_ID = "777";
  process.env.GH_APP_PRIVATE_KEY_PATH = "/nonexistent/t14623-app-key.pem";
  process.env.PATH = `${shim.dir}:/usr/bin:/bin`;
  process.env.RMD_GH_SHARED_READ_GAP_MS = "0";
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  let nowMs = STARTED_AT;
  const clock = clockFromMillisFn(() => nowMs);
  const h: Harness = {
    set: (ms) => void (nowMs = ms),
    tokens: [],
    rows: [],
    failures: 0,
    attempts: 0,
    shim,
    pass: (name, run) => {
      const refresh = async (o: RefreshOptions): Promise<RefreshResult> => {
        h.attempts += 1;
        if (h.failures > 0) { h.failures -= 1; return { ok: false, reason: "exchange rejected: 502" }; }
        const token = `ghs_W1T14623FAKE${h.tokens.length}${randomBytes(10).toString("hex")}`;
        h.tokens.push(token);
        o.env!.GH_TOKEN = token;
        return { ok: true, expiresAtMs: nowMs + HOUR_MS };
      };
      // The blocked loop: a timer is armed and never fires.
      const start: typeof startInstallationTokenRefresh = (opts) => startInstallationTokenRefresh({ ...opts, refresh,
        now: () => clock.now(), setTimer: () => ({ unref: () => {} }), clearTimer: () => {} });
      return withManagedGardenTokenRefresh(name, (step, fields) => void h.rows.push({ step, fields }), run, { start });
    },
  };
  return h;
}

function withState<T>(run: (state: string) => T): T {
  const state = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14623-`));
  try { return run(state); } finally { rmSync(state, { recursive: true, force: true }); }
}

const handFixRead = (state: string) =>
  readCiFrictionHandFixes(process.cwd(), state, "acme", "t14623-widgets", fixedClock(STARTED_AT + HOUR_MS + 8_000), undefined, () => "a".repeat(40));

test("W1-T14623 criterion 1: past the held token's expiry a gh call presents a renewed token, or is refused and never spawned", async (t) => {
  const h = harness(t);
  await h.pass("ci-friction", async () => {
    h.set(STARTED_AT + HOUR_MS + 1); // the loop was blocked; the timer never fired
    assert.equal((await ghTextAsync(READ_ARGS)).trim(), h.tokens[1], "the awaited call presents the renewed token");
    assert.equal(h.tokens.length, 2);
    assert.notEqual(h.tokens[1], h.tokens[0]);

    h.set(STARTED_AT + 2 * HOUR_MS + 2);
    h.failures = 1;
    const before = h.shim.calls().length;
    await assert.rejects(async () => ghCiFrictionEscalationIssues().listComments("https://github.com/acme/t14623-widgets/issues/1"),
      (err: { reason?: string }) => err.reason === "token_expired", "a release read whose renewal failed is refused");
    withState((state) => {
      const read = handFixRead(state);
      assert.equal(read.state, "unmeasured", "a synchronous read cannot await a renewal, so it is refused");
    });
    assert.equal(h.shim.calls().length, before, "a refused call is never spawned");
  });
});

test("W1-T14623 criterion 2: a call while the held token is unexpired is unchanged and mints nothing", async (t) => {
  const h = harness(t);
  await h.pass("ci-friction", async () => {
    h.set(STARTED_AT + HOUR_MS - 1);
    assert.equal((await ghTextAsync(READ_ARGS)).trim(), h.tokens[0]);
    assert.equal(h.attempts, 1, "only the pass's first mint");
  });
  // A pass this garden does not own installs nothing: the expired token is spent exactly as on origin/main.
  const other = harness(t);
  await other.pass("issue-revalidation", async () => {
    process.env.GH_TOKEN = "ghs_W1T14623UNMANAGED0000000000";
    other.set(STARTED_AT + 3 * HOUR_MS);
    assert.equal((await ghTextAsync(READ_ARGS)).trim(), "ghs_W1T14623UNMANAGED0000000000");
    assert.equal(other.attempts, 0);
  });
});

test("W1-T14623 criterion 3: ci-friction.hand_fixes_unmeasured names token_expired, not a bare gh 401", async (t) => {
  const h = harness(t);
  await h.pass("ci-friction", async () => {
    h.set(STARTED_AT + HOUR_MS + 5);
    withState((state) => {
      const read = handFixRead(state);
      assert.equal(read.state, "unmeasured");
      assert.ok(read.state === "unmeasured" && /token_expired/.test(read.reason), `reason: ${JSON.stringify(read)}`);
      assert.doesNotMatch(read.state === "unmeasured" ? read.reason : "", /401/);
    });
  });
  // After the pass the guard is gone: the same read spawns gh again.
  withState((state) => { handFixRead(state); });
  assert.ok(h.shim.calls().length > 0, "the wrapper uninstalls its guard when the pass ends");
});

test("W1-T14623 criterion 4: invariant:no-secret-in-a-row — no token or key reaches a row, a log line or argv", async (t) => {
  const h = harness(t);
  const messages: string[] = [];
  await h.pass("ci-friction", async () => {
    h.set(STARTED_AT + HOUR_MS + 1);
    await ghTextAsync(READ_ARGS);
    h.set(STARTED_AT + 2 * HOUR_MS + 2);
    h.failures = 1;
    await ghTextAsync(READ_ARGS).catch((err: Error) => void messages.push(err.message));
    withState((state) => { const read = handFixRead(state); if (read.state === "unmeasured") messages.push(read.reason); });
  });
  assert.equal(messages.length, 2);
  const text = JSON.stringify({ rows: h.rows, argv: h.shim.calls(), messages });
  for (const secret of h.tokens) assert.ok(!text.includes(secret), `a token leaked: ${text}`);
  assert.doesNotMatch(text, /PRIVATE KEY/);
});
