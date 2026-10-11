import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { Clock } from "../src/lib/clock.js";
import { LEDGER_PROJECTOR_SCHEMA_VERSION } from "../src/lib/ledger-projector.js";
import { openReadModel, type ReadModelDb } from "../src/lib/read-model-db.js";
import { createReadModelTicker, threadViews, type ReadModelInstanceState, type ReadModelViewFactory, type ReadModelWorkerMessage } from "../src/lib/read-model-worker.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { switchViewsOn } from "./helpers/read-model-switches.js";

const proof = "test/a-view-unit-s-measured-cost-survives-a-restart.test.ts";
const key = (instance: string | null) => `view_cost:${JSON.stringify(["sample", instance])}`;
type Context = { after(fn: () => void): void };

function fixture(t: Context) {
  const stateDir = makeTempDir("view-cost-restart");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const instances = ["core", "site"].map((name) => {
    const ledgerDir = join(stateDir, name);
    mkdirSync(ledgerDir);
    writeFileSync(join(ledgerDir, "ledger.ndjson"), "");
    return { name, ledgerDir };
  });
  switchViewsOn(stateDir, ["sample"], "shadow");
  let now = Date.parse("2026-10-11T12:00:00Z"), generation = 0;
  const clock: Clock = { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() };
  const advance = (ms: number) => void (now += ms);
  const db = (): ReadModelDb => {
    const opened = openReadModel({ stateDir, instance: "core", schemaVersion: LEDGER_PROJECTOR_SCHEMA_VERSION });
    t.after(() => opened.close());
    return opened;
  };
  function start(costs: Record<string, number>, onBuild?: (instance: string) => void, restoreCosts?: boolean) {
    const holder = `view-cost-generation-${++generation}`;
    const states: ReadModelWorkerMessage[] = [];
    const projector = createReadModelTicker({ stateDir, instances, views: [], oracle: "off", holder, clock, post: (m) => void states.push(m) });
    projector.start();
    const lane = (name: "fast" | "heavy") => {
      const builds: string[] = [], posts: ReadModelWorkerMessage[] = [];
      const factory: ReadModelViewFactory = { name: "sample", perInstance: true, create: () => ({ name: "sample", perInstance: true, version: 1,
        materialize: ({ instances: scoped }) => scoped.map(({ state }) => {
          builds.push(state.instance);
          advance(costs[state.instance] ?? 5);
          onBuild?.(state.instance);
          return { key: `instance=${state.instance}`, data: { instance: state.instance, unchanged: true }, sources: [] };
        }) }) };
      const ticker = createReadModelTicker({ stateDir, instances, views: [factory], viewsOnly: true, lane: name, oracle: "off", holder, clock,
        passBudgetMs: 100, ...(restoreCosts === undefined ? {} : { restoreCosts }), post: (m) => void posts.push(m) });
      const observe = () => {
        projector.tick();
        const state = states.findLast((m) => m.type === "state");
        assert.ok(state && state.type === "state");
        ticker.observe(state.instances as ReadModelInstanceState[]);
      };
      ticker.start();
      return { ticker, builds, posts, tick: () => { observe(); ticker.tick(); }, observe };
    };
    const fast = lane("fast"), heavy = lane("heavy");
    const stop = () => { fast.ticker.release(); heavy.ticker.release(); projector.release(); };
    t.after(stop);
    return { fast, heavy, stop };
  }
  return { start, db, advance };
}

test(`${proof}: a heavy cold unit starts heavy after restart while its last warm cost still budgets the first build`, (t) => {
  const f = fixture(t), costs = { core: 80, site: 5 }, first = f.start(costs);
  first.fast.tick();
  const moved = first.fast.posts.find((m) => m.type === "view_lane" && m.instance === "core");
  assert.ok(moved && moved.type === "view_lane" && moved.heavy);
  first.heavy.ticker.lane(moved);
  costs.core = 5;
  first.heavy.tick();
  first.stop();
  const restarted = f.start({ core: 5, site: 5 });
  restarted.fast.tick();
  assert.deepEqual(restarted.fast.builds, ["site"], "known expensive recreation cannot run on fast after restart");
  restarted.heavy.tick();
  assert.deepEqual(restarted.heavy.builds, ["core"]);
  assert.ok(restarted.heavy.posts.some((m) => m.type === "body" && m.entry.key === "instance=core"));
  const record = JSON.parse(f.db().meta(key("core"))!);
  assert.equal(record.costMs, 5, "pacing is current build cost, not the cold classification");
  assert.equal(record.coldCostMs, 80, "recreation cost survives both generations");
});

test(`${proof}: known affordable units share their first restarted pass instead of overshooting as unmeasured`, (t) => {
  const f = fixture(t), first = f.start({ core: 20, site: 20 });
  first.fast.tick();
  first.fast.tick();
  first.stop();
  const second = f.start({ core: 20, site: 20 });
  second.fast.tick();
  assert.deepEqual(second.fast.builds, ["core", "site"], "both known costs fit the restarted pass");
});

test(`${proof}: costs written by the current generation cannot grant a peer lane ownership before its handoff`, (t) => {
  const f = fixture(t), first = f.start({ core: 80 });
  first.fast.tick();
  first.heavy.tick();
  assert.deepEqual(first.heavy.builds, [], "only a previous generation's store can seed initial ownership");
  const move = first.fast.posts.find((m) => m.type === "view_lane" && m.instance === "core");
  assert.ok(move && move.type === "view_lane");
  first.heavy.ticker.lane(move);
  first.heavy.tick();
  assert.deepEqual(first.heavy.builds, ["core"]);
});

test(`${proof}: saved costs are per view and instance, and absent costs retain the unmeasured first build`, (t) => {
  const f = fixture(t), first = f.start({ core: 80, site: 5 });
  first.fast.tick();
  first.fast.tick();
  first.stop();
  const store = f.db();
  assert.ok(store.meta(key("core")));
  assert.ok(store.meta(key("site")));
  assert.equal(store.meta(key(null)), undefined);
  const second = f.start({ core: 5, site: 5 });
  second.fast.tick();
  assert.deepEqual(second.fast.builds, ["site"]);
  assert.ok(second.fast.posts.some((m) => m.type === "view_lane" && m.instance === "core" && m.heavy));
});

test(`${proof}: malformed, nonfinite and negative stored costs fall back without changing body output`, (t) => {
  for (const value of ["not json", "null", '{"version":1,"holder":"old","costMs":-1,"heavy":true}',
    '{"version":1,"holder":"old","costMs":"80","heavy":true}', '{"version":2,"holder":"old","costMs":80,"heavy":true}',
    '{"version":1,"holder":"old","costMs":1e999}', '{"version":1,"holder":"old","costMs":5,"coldCostMs":-1}',
    '{"version":1,"holder":"old","costMs":5,"coldCostMs":"80"}', '{"version":1,"holder":"old","costMs":5,"coldCostMs":1e999}',
    '{"version":1,"costMs":80,"heavy":true}']) {
    const f = fixture(t), empty = f.start({ core: 5 });
    empty.stop();
    f.db().prepare("INSERT INTO meta(k,v) VALUES(?,?)").run(key("core"), value);
    const next = f.start({ core: 5 });
    next.fast.tick();
    assert.deepEqual(next.fast.builds, ["core"], value);
    const body = next.fast.posts.find((m) => m.type === "body");
    assert.ok(body && body.type === "body");
    assert.deepEqual(body.entry.body.data, { instance: "core", unchanged: true });
    next.stop();
  }
});

test(`${proof}: no recorded costs behaves as before and a failed materialization records no cost`, (t) => {
  const f = fixture(t), broken = f.start({ core: 80 }, () => { throw new Error("fixture materialization failure"); });
  broken.fast.tick();
  assert.deepEqual(broken.fast.builds, ["core"]);
  assert.equal(f.db().meta(key("core")), undefined);
  broken.stop();
  const next = f.start({ core: 80 });
  next.fast.tick();
  assert.deepEqual(next.fast.builds, ["core"]);
});

test(`${proof}: a rejected SQLite cost write does not discard the successfully published body`, (t) => {
  const f = fixture(t), first = f.start({ core: 80 });
  f.db().exec("CREATE TRIGGER reject_view_cost BEFORE INSERT ON meta WHEN NEW.k LIKE 'view_cost:%' BEGIN SELECT RAISE(ABORT, 'fixture cost write refused'); END");
  first.fast.tick();
  assert.ok(first.fast.posts.some((m) => m.type === "body" && m.entry.key === "instance=core"));
  assert.ok(first.fast.posts.some((m) => m.type === "log" && m.step === "read_model.view_cost_write_failed"));
  assert.equal(f.db().meta(key("core")), undefined);
});

test(`${proof}: persisted classification cannot undo an explicit lane reclaim`, (t) => {
  const f = fixture(t), first = f.start({ core: 80 });
  first.fast.tick();
  first.stop();
  const second = f.start({ core: 5 });
  second.fast.tick();
  assert.deepEqual(second.fast.builds, ["site"]);
  second.fast.ticker.lane({ heavy: false, dueAt: 0 });
  f.advance(500);
  second.fast.tick();
  assert.ok(second.fast.builds.includes("core"), "failover still takes ownership; storage must not reseed it");
});

test(`${proof}: a respawned lane may not restore ownership already reclaimed by its surviving peer`, (t) => {
  const f = fixture(t), first = f.start({ core: 80 });
  first.fast.tick();
  first.stop();
  const respawned = f.start({ core: 5 }, undefined, false);
  respawned.heavy.tick();
  assert.deepEqual(respawned.heavy.builds, [], "a respawn starts unowned, rather than duplicating the survivor's cache");
  respawned.fast.tick();
  assert.deepEqual(respawned.fast.builds, ["core"]);
});

test(`${proof}: a replaced writer lease fences cost updates just as it fences view bodies`, (t) => {
  const f = fixture(t), costs = { core: 80 }, first = f.start(costs);
  const store = f.db();
  first.fast.tick();
  const prior = store.meta(key("core"));
  assert.ok(prior);
  costs.core = 5;
  store.prepare("UPDATE lease SET holder='new-generation' WHERE name='projector'").run();
  first.fast.ticker.lane({ heavy: false, dueAt: 0 });
  f.advance(500);
  first.fast.ticker.tick();
  assert.equal(store.meta(key("core")), prior, "an old lane cannot change a newer generation's store");
  assert.ok(first.fast.posts.some((m) => m.type === "log" && m.step === "read_model.view_cost_write_failed" && String(m.extra.error).includes("no longer owns")));
});

test(`${proof}: the real lane spawner restores on generation boot but not after a peer has reclaimed a dead lane`, async (t) => {
  const dir = makeTempDir("view-cost-spawn");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workerPath = join(dir, "worker.mjs");
  writeFileSync(workerPath, `import { parentPort, workerData } from "node:worker_threads";
parentPort.postMessage({ type: "log", step: "fixture.boot", extra: { lane: workerData.lane, restoreCosts: workerData.restoreCosts } });
parentPort.on("message", (msg) => {
  if (msg.type === "stop") process.exit(0);
  if (msg.type !== "want") return;
  if (msg.view === "move" && workerData.lane === "fast") parentPort.postMessage({ type: "view_lane", view: "sample", instance: "core", heavy: true, costMs: 80, dueAt: 0 });
  if (msg.view === "die" && workerData.lane === "heavy") process.exit(3);
});`);
  const messages: ReadModelWorkerMessage[] = [];
  const lanes = threadViews({ data: { stateDir: dir, instances: [], tickMs: 20, holder: "fixture" }, workerUrl: pathToFileURL(workerPath),
    relay: (m) => void messages.push(m), log: () => {} });
  t.after(() => lanes.close());
  const boots = () => messages.flatMap((m) => m.type === "log" && m.step === "fixture.boot" ? [m.extra] : []);
  const until = async (count: number) => {
    // BACKSTOP: only this disposable worker's startup; the assertion never accepts missing rows.
    const deadline = Date.now() + 10_000;
    while (boots().length < count && Date.now() < deadline) await sleep(5);
    assert.equal(boots().length, count);
  };
  await until(1);
  lanes.want("move", "");
  await until(2);
  lanes.want("die", "");
  await until(3);
  assert.deepEqual(boots(), [{ lane: "fast", restoreCosts: true }, { lane: "heavy", restoreCosts: true }, { lane: "heavy", restoreCosts: false }]);
});
