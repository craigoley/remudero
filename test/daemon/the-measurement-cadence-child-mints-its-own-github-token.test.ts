// W1-T11179: the cadence child read GitHub with the GH_TOKEN it was spawned with, so every child that
// outlived that token's hour got "Bad credentials (HTTP 401)" from the board gateway.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { refreshInstallationToken, type RefreshOptions } from "#src/lib/github-app.js";
import type { LedgerLine } from "#src/lib/ledger.js";
// Namespace import: the entry's new export reads undefined at base, so each test fails on its own assertion.
import * as child from "#src/measurement-cadence-child.js";

const HOUR_MS = 60 * 60 * 1000;
const T0 = Date.parse("2026-11-03T00:00:00.000Z");
const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const SPAWN_TIME_TOKEN = "spawn-time-token-value";

function appEnv(): NodeJS.ProcessEnv {
  return { GH_APP_ID: "11", GH_APP_INSTALLATION_ID: "22", GH_APP_PRIVATE_KEY_PATH: "/fixture/app-key.pem", GH_TOKEN: SPAWN_TIME_TOKEN };
}

/** The real token exchange with only its network, key read and clock injected. */
function exchange(responses: Array<{ status: number; token?: string }>, clock: () => number, calls: string[]) {
  return (o: RefreshOptions) =>
    refreshInstallationToken({
      ...o,
      now: clock,
      readKey: () => PEM,
      fetchImpl: (async (url: string) => {
        calls.push(String(url));
        const next = responses.shift() ?? { status: 500 };
        const body = next.token ? { token: next.token, expires_at: new Date(clock() + HOUR_MS).toISOString() } : { message: "no" };
        return new Response(JSON.stringify(body), { status: next.status, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
}

function harness(responses: Array<{ status: number; token?: string }>) {
  let now = T0;
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const calls: string[] = [];
  const rows: LedgerLine[] = [];
  const deps = {
    refresh: exchange(responses, () => now, calls),
    setTimer: (fn: () => void, ms: number) => {
      const timer = { fn, ms, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer: { unref?: () => void }) => {
      (timer as { cleared: boolean }).cleared = true;
    },
    now: () => now,
    ledger: (row: LedgerLine) => rows.push(row),
  };
  return { deps, timers, calls, rows, advance: (ms: number) => (now += ms) };
}

test("W1-T11179 criterion 1: the child awaits its own first mint before the cadence runs, and starts none without an App", async () => {
  assert.equal(typeof child.withMeasurementCadenceChildToken, "function", "the child entry exposes its token wiring");
  const h = harness([{ status: 201, token: "minted-token-one" }]);
  const env = appEnv();
  let seenAtRun: string | undefined;
  const code = await child.withMeasurementCadenceChildToken({ runId: "MEASUREMENT-CADENCE-CHILD-1", env, ...h.deps, run: async () => {
    seenAtRun = env.GH_TOKEN;
    return 0;
  } });
  assert.equal(code, 0);
  assert.equal(h.calls.length, 1, "one installation-token exchange before the run");
  assert.equal(seenAtRun, "minted-token-one", "the cadence's first step reads the child's own mint, not the spawn-time copy");

  const bare = harness([{ status: 201, token: "never-minted" }]);
  const plain: NodeJS.ProcessEnv = { GH_TOKEN: SPAWN_TIME_TOKEN };
  let plainAtRun: string | undefined;
  await child.withMeasurementCadenceChildToken({ runId: "MEASUREMENT-CADENCE-CHILD-2", env: plain, ...bare.deps, run: async () => {
    plainAtRun = plain.GH_TOKEN;
    return 0;
  } });
  assert.deepEqual([bare.calls.length, bare.timers.length, bare.rows.length], [0, 0, 0], "no App configured: no exchange, no timer, no row");
  assert.equal(plainAtRun, SPAWN_TIME_TOKEN, "the inherited GH_TOKEN is read unchanged");
});

test("W1-T11179 criterion 2: a child that outlives one token reads GitHub with the next, and stops its refresher when the run settles", async () => {
  const h = harness([{ status: 201, token: "minted-token-one" }, { status: 201, token: "minted-token-two" }]);
  const env = appEnv();
  let renewedAtRun: string | undefined;
  await child.withMeasurementCadenceChildToken({ runId: "MEASUREMENT-CADENCE-CHILD-3", env, ...h.deps, run: async () => {
    const renewal = h.timers.at(-1);
    assert.ok(renewal, "the first mint schedules its renewal");
    assert.ok(renewal.ms < HOUR_MS, "the renewal is due inside the first token's life");
    h.advance(renewal.ms);
    renewal.fn();
    for (let i = 0; i < 50 && env.GH_TOKEN !== "minted-token-two"; i++) await new Promise((r) => setImmediate(r));
    renewedAtRun = env.GH_TOKEN;
    return 0;
  } });
  assert.equal(renewedAtRun, "minted-token-two", "past the renewal the child's GH_TOKEN is the second mint");
  assert.notEqual(renewedAtRun, SPAWN_TIME_TOKEN);
  assert.equal(h.timers.at(-1)?.cleared, true, "the refresher is stopped when the run settles");
});

test("W1-T11179 criterion 3: every mint and failed exchange is ledgered under the child's run id, never with the token", async () => {
  const h = harness([{ status: 201, token: "minted-token-one" }, { status: 401 }]);
  const env = appEnv();
  await child.withMeasurementCadenceChildToken({ runId: "MEASUREMENT-CADENCE-CHILD-4", env, ...h.deps, run: async () => {
    const renewal = h.timers.at(-1)!;
    h.advance(renewal.ms);
    renewal.fn();
    for (let i = 0; i < 50 && !h.rows.some((r) => r.step === "github_app.token_refresh_failed"); i++) await new Promise((r) => setImmediate(r));
    return 0;
  } });
  const steps = h.rows.map((r) => r.step);
  assert.deepEqual(steps.slice(0, 2), ["github_app.token_refreshed", "github_app.token_refresh_failed"]);
  for (const row of h.rows) assert.equal(row.run_id, "MEASUREMENT-CADENCE-CHILD-4", `${row.step} is ledgered under the child's run id`);
  assert.match(String(h.rows[0].expires_at), /^2026-11-03T01:00:00/);
  assert.equal(h.rows[1].reason, "exchange rejected: 401");
  const text = JSON.stringify(h.rows);
  assert.ok(!text.includes("minted-token-one") && !text.includes(SPAWN_TIME_TOKEN), "no row carries a token");
});
