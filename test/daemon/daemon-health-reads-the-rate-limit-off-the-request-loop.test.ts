/**
 * W1-T13833 — GET /v1/daemon-health reads `gh api rate_limit` off serve's request loop, and holds the reading.
 *
 * The route ran the read with execFileSync on every request: a 10-minute host profile (2026-11-19 12:18–12:28Z)
 * put 2.45 s of serve's main-thread stalls in its `defaultGhExec`. Now one read is in flight at a time, without
 * blocking; a request before the first reading lands awaits it, and later requests answer at once with the held
 * reading, refreshing it in the background once it is older than DAEMON_HEALTH_RATE_LIMIT_HOLD_MS.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildDaemonHealthRoute, DAEMON_HEALTH_RATE_LIMIT_HOLD_MS, type DaemonHealthDeps } from "#src/lib/daemon-health.js";
import { createService } from "#src/lib/service.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim } from "#test/helpers/gh-shim.js";

const READ = "w1t13833-read";
const WRITE = "w1t13833-write";

async function withRoute<T>(t: { after: (fn: () => void) => void }, deps: Partial<DaemonHealthDeps>, fn: (get: () => Promise<Record<string, unknown>>) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t13833-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const route = buildDaemonHealthRoute({ ledgerPath, diskPath: dir, statfs: () => ({ bavail: 1, bsize: 1, blocks: 0, bfree: 0 }), ...deps });
  const server = createService({ tokens: { read: READ, write: WRITE }, routes: [route] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    return await fn(async () => {
      const res = await fetch(`${base}/v1/daemon-health`, { headers: { authorization: `Bearer ${READ}` } });
      assert.equal(res.status, 200);
      return await res.json() as Record<string, unknown>;
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("W1-T13833 criterion 1: the default rate-limit read runs gh without blocking the loop", { timeout: 10_000 }, async (t) => {
  const shim = ghShim([{ when: "api rate_limit", stdout: JSON.stringify({ resources: { core: { remaining: 4321 } } }), delaySeconds: 0.5 }]);
  const saved = process.env.PATH;
  process.env.PATH = `${shim.dir}:${saved}`;
  t.after(() => { process.env.PATH = saved; rmSync(shim.dir, { recursive: true, force: true }); });
  await withRoute(t, {}, async (get) => {
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 20);
    let body: Record<string, unknown>;
    try {
      body = await get();
    } finally {
      clearInterval(timer);
    }
    assert.equal(body.rateLimitRemaining, 4321, "the first request awaits the first reading");
    assert.ok(ticks >= 15, `the loop must keep servicing timers while gh api rate_limit is pending (ticked ${ticks})`);
    assert.equal(shim.calls().filter((call) => call.includes("rate_limit")).length, 1);
  });
});

test("W1-T13833 criterion 2: one reading is held for the hold window, then refreshed in the background, one read at a time", { timeout: 10_000 }, async (t) => {
  let now = Date.parse("2026-11-19T12:00:00.000Z");
  let reads = 0;
  const answers: Array<(value: number | undefined) => void> = [];
  const rateLimit = () => { reads += 1; return new Promise<number | undefined>((resolve) => answers.push(resolve)); };
  await withRoute(t, { rateLimit, now: () => now }, async (get) => {
    const first = [get(), get()];
    while (answers.length === 0) await new Promise((resolve) => setImmediate(resolve));
    answers.shift()!(100);
    const bodies = await Promise.all(first);
    assert.deepEqual(bodies.map((body) => body.rateLimitRemaining), [100, 100]);
    assert.equal(reads, 1, "two requests before the first reading share one read");
    now += DAEMON_HEALTH_RATE_LIMIT_HOLD_MS - 1;
    assert.equal((await get()).rateLimitRemaining, 100);
    assert.equal(reads, 1, "inside the hold window no request reads again");
    now += 1;
    assert.equal((await get()).rateLimitRemaining, 100, "an expired reading still answers at once");
    assert.equal(reads, 2, "and starts exactly one background read");
    assert.equal((await get()).rateLimitRemaining, 100);
    assert.equal(reads, 2, "a read in flight is never doubled");
    answers.shift()!(undefined);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await get()).rateLimitRemaining, undefined, "a failed read holds no number, so the field is absent");
  });
});
