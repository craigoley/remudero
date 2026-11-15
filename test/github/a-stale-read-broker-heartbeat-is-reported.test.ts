import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GH_BROKER_HEARTBEAT, ghBrokerDir, ghBrokerDirLive } from "#src/lib/gh-read-broker-client.js";
import {
  GH_BROKER_LAUNCH_AGENT, GH_BROKER_NOT_SERVING_STEP, GH_BROKER_RECOVERED_STEP, GH_BROKER_STALE_STEP, GH_BROKER_UNKNOWN_STEP,
  watchReadBrokerHeartbeat, type ReadBrokerWatchState,
} from "#src/lib/gh-read-broker-watch.js";

const NOW_MS = Date.UTC(2026, 10, 9, 18, 30);

/** A host of its own: a cache root and a HOME, both temp dirs, read through the real filesystem. */
function host(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rmd-broker-watch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { RMD_GH_CACHE_HOME: join(root, "cache"), HOME: join(root, "home") };
  const dir = ghBrokerDir(env)!;
  const heartbeat = join(dir, GH_BROKER_HEARTBEAT);
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const state: ReadBrokerWatchState = {};
  const beat = (ageMs: number, body = "10\n") => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(heartbeat, body);
    const at = new Date(NOW_MS - ageMs);
    utimesSync(heartbeat, at, at);
  };
  const watch = (nowMs = NOW_MS, e: NodeJS.ProcessEnv = env) =>
    watchReadBrokerHeartbeat(state, (step, extra) => rows.push({ step, extra }), { env: e, nowMs });
  return { root, env, dir, heartbeat, rows, state, beat, watch };
}

test("W1-T11944 criterion 1: a heartbeat older than twice its interval writes one row naming its age and interval, a fresh one none", (t) => {
  const fresh = host(t);
  fresh.beat(5_000);
  assert.equal(fresh.watch().state, "fresh");
  fresh.beat(19_999);
  assert.equal(fresh.watch().state, "fresh");
  assert.deepEqual(fresh.rows, [], "a fresh heartbeat writes no row");

  const stale = host(t);
  stale.beat(25_000);
  assert.equal(stale.watch().state, "stale");
  assert.deepEqual(stale.rows, [{
    step: GH_BROKER_STALE_STEP,
    extra: { heartbeat: stale.heartbeat, age_ms: 25_000, interval_s: 10, threshold_ms: 20_000, mode: "shadow" },
  }]);

  // The interval is the broker's own: a 60 s heartbeat 25 s old is fresh, and stale only past 120 s.
  const slow = host(t);
  slow.beat(25_000, "60\n");
  assert.equal(slow.watch().state, "fresh");
  slow.beat(121_000, "60\n");
  assert.equal(slow.watch().state, "stale");
  assert.equal(slow.rows.length, 1);
  assert.equal(slow.rows[0].extra?.interval_s, 60);
});

test("W1-T11944 criterion 2: a heartbeat that stays stale writes one row per episode, and a fresh one closes it recovered", (t) => {
  const h = host(t);
  h.beat(30_000);
  for (let tick = 0; tick < 5; tick += 1) assert.equal(h.watch(NOW_MS + tick * 60_000).state, "stale");
  assert.deepEqual(h.rows.map((r) => r.step), [GH_BROKER_STALE_STEP], "five stale ticks, one row");

  h.beat(-599_000); // the broker beats again ten minutes on, and keeps beating
  assert.equal(h.watch(NOW_MS + 600_000).state, "fresh");
  h.beat(-659_000);
  assert.equal(h.watch(NOW_MS + 660_000).state, "fresh");
  assert.deepEqual(h.rows.map((r) => r.step), [GH_BROKER_STALE_STEP, GH_BROKER_RECOVERED_STEP]);
  assert.deepEqual(h.rows[1].extra, { after: "stale", episode_ms: 600_000, now: "fresh" });
  assert.equal(h.state.episode, undefined);

  // A second outage is a second episode, with its own row.
  h.beat(-660_000); // then stops: 40 s silent at the next tick
  h.watch(NOW_MS + 700_000);
  assert.deepEqual(h.rows.map((r) => r.step), [GH_BROKER_STALE_STEP, GH_BROKER_RECOVERED_STEP, GH_BROKER_STALE_STEP]);
});

test("W1-T11944 criterion 3: no heartbeat on a host that runs the broker unit is no broker serving, and a host that never ran one is not reported", (t) => {
  const served = host(t);
  mkdirSync(served.dir, { recursive: true }); // a broker served here once and is gone
  assert.equal(served.watch().state, "no_broker_serving");
  served.watch(NOW_MS + 60_000);
  assert.deepEqual(served.rows, [{ step: GH_BROKER_NOT_SERVING_STEP, extra: { heartbeat: served.heartbeat, mode: "shadow" } }]);

  const installed = host(t);
  mkdirSync(join(installed.env.HOME!, "Library/LaunchAgents"), { recursive: true });
  writeFileSync(join(installed.env.HOME!, GH_BROKER_LAUNCH_AGENT), "<plist/>\n"); // installed, never started
  assert.equal(installed.watch().state, "no_broker_serving");
  assert.deepEqual(installed.rows.map((r) => r.step), [GH_BROKER_NOT_SERVING_STEP]);
  installed.beat(1_000);
  installed.watch();
  assert.deepEqual(installed.rows[1], { step: GH_BROKER_RECOVERED_STEP, extra: { after: "no_broker_serving", episode_ms: 0, now: "fresh" } });

  const never = host(t);
  assert.equal(never.watch().state, "not_installed");
  assert.deepEqual(never.rows, [], "a host that never ran a broker writes nothing");

  // A test process never watches the account's real broker: with no cache root of its own it reads nothing.
  const testProcess = host(t);
  mkdirSync(join(testProcess.env.HOME!, "Library/LaunchAgents"), { recursive: true });
  writeFileSync(join(testProcess.env.HOME!, GH_BROKER_LAUNCH_AGENT), "<plist/>\n");
  assert.equal(testProcess.watch(NOW_MS, { HOME: testProcess.env.HOME, NODE_TEST_CONTEXT: "child" }).state, "not_installed");
  assert.deepEqual(testProcess.rows, []);
});

test("W1-T11944 criterion 4: the check never changes whether a read is allowed, and an unreadable heartbeat is unknown and fails open", (t) => {
  // A stale heartbeat stays exactly as the readers see it: the watch neither rewrites nor removes it.
  const stale = host(t);
  stale.beat(30_000);
  const before = { body: readFileSync(stale.heartbeat, "utf8"), mtimeMs: statSync(stale.heartbeat).mtimeMs };
  const liveBefore = ghBrokerDirLive(stale.dir, NOW_MS - 15_000);
  stale.watch();
  assert.deepEqual({ body: readFileSync(stale.heartbeat, "utf8"), mtimeMs: statSync(stale.heartbeat).mtimeMs }, before);
  assert.equal(ghBrokerDirLive(stale.dir, NOW_MS - 15_000), liveBefore);
  assert.equal(ghBrokerDirLive(stale.dir, NOW_MS), undefined, "a reader still floors a stale broker by its own rule");

  // A heartbeat that cannot be read is unknown, said once, and never throws into the tick.
  const unreadable = host(t);
  mkdirSync(unreadable.heartbeat, { recursive: true });
  const reading = unreadable.watch();
  assert.equal(reading.state, "unknown");
  unreadable.watch(NOW_MS + 60_000);
  assert.deepEqual(unreadable.rows.map((r) => r.step), [GH_BROKER_UNKNOWN_STEP]);
  assert.match(String(unreadable.rows[0].extra?.reason), /heartbeat unreadable: EISDIR/);
  assert.equal(unreadable.rows[0].extra?.fails, "open");

  // A heartbeat declaring no interval cannot be judged stale, so it is unknown too, never refused.
  const garbled = host(t);
  garbled.beat(1_000, "");
  assert.equal(garbled.watch().state, "unknown");
  assert.match(String(garbled.rows[0].extra?.reason), /declares no interval/);

  // With no cache root at all there is nothing to find; that too is unknown, not a refusal.
  const rootless = host(t);
  assert.equal(rootless.watch(NOW_MS, {}).state, "unknown");
  assert.match(String(rootless.rows[0].extra?.reason), /no cache root/);
});
