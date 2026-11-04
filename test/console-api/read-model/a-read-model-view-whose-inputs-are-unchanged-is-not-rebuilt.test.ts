import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ReadModelDb } from "#src/lib/read-model-db.js";
import { publishThreadPlan } from "#src/lib/thread-plan.js";
import { createDemandBook } from "#src/lib/view-demand.js";
import {
  createReadModelTicker, ledgerSource, READ_MODEL_READ_HOT_MS, readModelLaneViews, readModelSwitchesPath,
  type ReadModelView, type ReadModelWorkerMessage,
} from "#src/lib/read-model-worker.js";
import { closeReadModelFixture, readModelFixtureDir } from "#test/helpers/read-model-fixture.js";

const START = Date.parse("2026-11-02T12:00:00Z");
const iso = (at: number): string => new Date(at).toISOString();

function fixture(t: TestContext, names = ["core"], production = false) {
  const dir = readModelFixtureDir(t, "unchanged-view");
  const planPath = join(dir, "plan.yaml");
  writeFileSync(planPath, "tasks: []\n");
  const instances = names.map(name => {
    const ledgerDir = join(dir, name);
    mkdirSync(ledgerDir);
    writeFileSync(join(ledgerDir, "ledger.ndjson"), JSON.stringify({ ts: iso(START), step: "daemon.tick" }) + "\n");
    return { name, ledgerDir, planPath };
  });
  let now = START;
  let ready = true;
  let fail = false;
  let empty = false;
  let materialized = 0;
  const stores = new Map<string, ReadModelDb>();
  const messages: ReadModelWorkerMessage[] = [];
  const clock = { now: () => now, date: () => new Date(now), iso: () => iso(now) };
  const laneView = readModelLaneViews({ instances }, clock, () => {}, createDemandBook({ clock }))
    .find(view => view.name === "read-model")!;
  assert.ok(!("create" in laneView));
  const view: ReadModelView = production ? { ...laneView, materialize: ctx => {
    materialized++;
    now += 100;
    for (const { state, db } of ctx.instances) if (db) stores.set(state.instance, db);
    return laneView.materialize(ctx);
  } } : {
    name: "digest", version: 1, perInstance: true, readPaced: true,
    ledgerReads: db => {
      const beat = db.prepare("SELECT last_ms FROM instance_heartbeat WHERE k = 'daemon'").get();
      return beat ? iso(Number(beat.last_ms)) : null;
    },
    prepare: () => ready,
    materialize: ctx => {
      materialized++;
      now += 100;
      if (fail) throw new Error("fixture materialize failed");
      if (empty) return [];
      return ctx.instances.map(({ state, db }) => {
        assert.ok(db);
        stores.set(state.instance, db);
        return { key: `instance=${state.instance}`, data: { serial: materialized }, sources: [
          ledgerSource(state, ctx.now), { name: `plan:${state.instance}`, asOf: iso(ctx.now), state: "fresh" },
        ] };
      });
    },
  };
  mkdirSync(join(dir, "read-model"));
  const switchesPath = readModelSwitchesPath(dir);
  const switches = (push: "on" | "off" = "off") => {
    writeFileSync(switchesPath, JSON.stringify({ projector: "on", views: { [view.name]: "serve" }, push }));
    utimesSync(switchesPath, new Date(now), new Date(now));
  };
  switches();
  const ticker = createReadModelTicker({
    stateDir: dir, instances, views: [view], oracle: "off", holder: "digest-test",
    clock,
    post: message => { messages.push(message); },
  });
  closeReadModelFixture(t, () => ticker.release());
  ticker.start();
  const tick = (ms = 1_000) => { now += ms; ticker.tick(); };
  const append = (name = "core", step = "daemon.tick", at = now) => {
    appendFileSync(join(dir, name, "ledger.ndjson"), JSON.stringify({ ts: iso(at), step }) + "\n");
  };
  const body = () => {
    const message = messages.filter(m => m.type === "body").at(-1);
    assert.ok(message?.type === "body");
    return message.entry;
  };
  return {
    ticker, view, stores, messages, planPath, tick, append, body, switches,
    count: () => materialized, now: () => now,
    ready: (value: boolean) => { ready = value; },
    fail: (value: boolean) => { fail = value; },
    empty: (value: boolean) => { empty = value; },
  };
}

test("test/console-api/read-model/a-read-model-view-whose-inputs-are-unchanged-is-not-rebuilt.test.ts", t => {
  const f = fixture(t, ["core", "console"], true);
  f.tick();
  const built = f.body();
  assert.equal(built.view, "read-model", "exercise the production lane registration");
  assert.deepEqual(built.body.data, { instances: ["core", "console"].map(instance => ({
    instance, generation: 1, lease: "held", quarantined: 0,
  })) });
  for (let i = 0; i < 5; i++) {
    f.append("core", "read_model.slow_view");
    f.tick();
  }
  assert.equal(f.count(), 1, "unchanged production inputs bypass materialize, even with diagnostic rows");
  assert.equal(f.body(), built, "the body, ETag and generatedAt survive reuse");
  const refreshed = f.messages.flatMap(m => m.type === "sources" ? m.bodies ?? [] : []).at(-1);
  assert.ok(refreshed);
  assert.deepEqual(refreshed.sources.map(s => [s.name, s.asOf, s.state, s.lagMs]), [
    ["ledger:core", "2026-11-02T12:00:05.100Z", "fresh", 0], ["ledger:console", "2026-11-02T12:00:00.000Z", "fresh", 0],
  ], "sources are restamped at the latest projector check, each as of its projector head");
  f.tick(600_000);
  const row = f.messages.find(m => m.type === "log" && m.step === "read_model.view_builds" && m.extra.view === "read-model");
  assert.ok(row?.type === "log");
  assert.equal(row.extra.builds, 1);
  assert.equal(row.extra.skipped, 6);
  assert.equal(row.extra.calls, 7);
  assertSourceRestamping(t);
});

function assertSourceRestamping(t: TestContext): void {
  const f = fixture(t);
  f.tick();
  const built = f.body();
  for (let i = 0; i < 5; i++) f.tick();
  assert.equal(f.count(), 1, "only the cold call materializes");
  assert.equal(f.body(), built, "the data, ETag and generatedAt are kept");
  const refreshed = f.messages.flatMap(m => m.type === "sources" ? m.bodies ?? [] : []).at(-1);
  assert.ok(refreshed);
  assert.equal(refreshed.sources.find(s => s.name === "plan:core")?.asOf, iso(f.now()));
  assert.equal(refreshed.sources.find(s => s.name === "ledger:core")?.asOf, iso(START));
  f.tick(600_000);
  const row = f.messages.find(m => m.type === "log" && m.step === "read_model.view_builds" && m.extra.view === "digest");
  assert.ok(row?.type === "log");
  assert.equal(row.extra.builds, 1);
  assert.equal(row.extra.skipped, 6);
  assert.equal(row.extra.calls, 7);
}

test("production status rebuilds for every declared input and for quarantine changes without a generation", t => {
  const f = fixture(t, ["core"], true);
  f.tick();
  f.tick();
  assert.equal(f.count(), 1);
  f.append();
  f.tick();
  assert.equal(f.count(), 2, "a contributing ledger row moves the store generation");
  writeFileSync(f.planPath, "tasks: []\n# changed production plan\n");
  f.tick();
  assert.equal(f.count(), 3);
  f.switches("on");
  f.tick(5_000);
  assert.equal(f.count(), 4);
  const future = f.now() + 3_600_000;
  const db = f.stores.get("core")!;
  const generation = db.meta("generation");
  f.append("core", "read_model.slow_view", future);
  f.tick();
  assert.equal(f.count(), 5, "the read-as-of for quarantined rows moved");
  assert.equal(db.meta("generation"), generation, "quarantined diagnostics do not move generation");
  f.append("core", "read_model.materialize_deferred", future);
  f.tick();
  assert.equal(f.count(), 6, "a second quarantined row at the same as-of must invalidate");
  assert.equal(db.meta("generation"), generation);
  assert.deepEqual(f.body().body.data, { instances: [{ instance: "core", generation: Number(generation), lease: "held", quarantined: 2 }] });
  assert.equal(f.body().body.sources[0].asOf, iso(future));
  f.tick();
  assert.equal(f.count(), 6, "the new production body can be reused");
});

test("production status includes observed state in its digest and rebuilds unhealthy inputs", t => {
  const f = fixture(t, ["core"], true);
  f.tick();
  const message = f.messages.filter(m => m.type === "state").at(-1);
  assert.ok(message?.type === "state");
  const state = message.instances[0];
  const build = () => f.ticker.buildNow("read-model");
  build();
  assert.equal(f.count(), 1);
  f.ticker.observe([{ ...state, generation: state.generation + 1 }]);
  build();
  assert.equal(f.count(), 2, "observed generation can move before the store changes");
  f.ticker.observe([{ ...state, heldBy: "observer" }]);
  build();
  assert.equal(f.count(), 3);
  assert.deepEqual(f.body().body.data, { instances: [{ instance: "core", generation: state.generation, lease: "held", heldBy: "observer", quarantined: 0 }] });
  f.ticker.observe([{ ...state, reason: "projection failed", failures: 1 }]);
  build();
  build();
  assert.equal(f.count(), 5, "failed projection cannot certify reuse");
  assert.equal(f.body().body.stale, true);
  assert.match(f.body().body.sources[0].reason!, /projection failed/);
  f.ticker.observe([state]);
  build();
  build();
  build();
  assert.equal(f.count(), 7, "after restoring fresh sources the status can be reused again");
});

// W1-T11127 criterion 2: changed, cold, failed, unready and unreadable inputs still build; pacing survives.
test("W1-T11127 criterion 2: ledger readings, plan identity, store generations and switches invalidate", t => {
  const f = fixture(t);
  f.tick();
  f.tick();
  assert.equal(f.count(), 1);
  f.append();
  f.tick();
  assert.equal(f.count(), 2);
  writeFileSync(f.planPath, "tasks: []\n# changed plan\n");
  f.tick();
  assert.equal(f.count(), 3);
  f.append("core", "run.start");
  f.tick();
  assert.equal(f.count(), 4, "a store generation can move without the declared heartbeat moving");
  assert.equal(f.ticker.acceptSnapshot({ instance: "core", ok: true, asOf: iso(f.now()), bodies: [{ name: "signals", body: {} }] }), true);
  f.tick();
  assert.equal(f.count(), 5, "a source snapshot can move without the ledger generation moving");
  f.switches("on");
  f.tick(5_000);
  assert.equal(f.count(), 6);
});

test("W1-T11127 criterion 2: a failed, unready or empty build invalidates the last successful digest", t => {
  const f = fixture(t);
  f.tick();
  f.ready(false);
  f.tick();
  assert.equal(f.count(), 1);
  f.ready(true);
  f.tick();
  assert.equal(f.count(), 2);
  f.append();
  f.fail(true);
  f.tick();
  assert.equal(f.count(), 3);
  f.fail(false);
  f.tick();
  assert.equal(f.count(), 4);
  f.append();
  f.empty(true);
  f.tick();
  f.empty(false);
  f.tick();
  assert.equal(f.count(), 6);
  f.tick();
  assert.equal(f.count(), 6, "a successful recovery is reusable");
});

test("W1-T11127 criterion 2: missing ledgerReads and unreadable store generations build conservatively", t => {
  const f = fixture(t);
  f.tick();
  const db = f.stores.get("core")!;
  const meta = db.meta;
  t.after(() => { db.meta = meta; });
  db.meta = key => key === "generation" ? undefined : meta(key);
  f.ticker.buildNow("digest");
  assert.equal(f.count(), 2);
  db.meta = key => {
    if (key === "generation") throw new Error("fixture generation unreadable");
    return meta(key);
  };
  f.ticker.buildNow("digest");
  assert.equal(f.count(), 3);
  db.meta = meta;
  f.ticker.buildNow("digest");
  assert.equal(f.count(), 4, "an unreadable digest was never cached");
  delete f.view.ledgerReads;
  f.tick();
  f.tick();
  assert.equal(f.count(), 6);
});

test("W1-T11127 criterion 2: a new pinned plan sha invalidates unchanged plan files", t => {
  const f = fixture(t);
  const pin = (ref: string) => publishThreadPlan({ path: f.planPath, repoDir: f.planPath, ref }, { plan: { tasks: [], byId: new Map() }, quarantined: [] });
  pin("a".repeat(40));
  f.tick();
  f.tick();
  assert.equal(f.count(), 1);
  pin("b".repeat(40));
  f.tick();
  assert.equal(f.count(), 2);
  f.tick();
  assert.equal(f.count(), 2);
});

test("W1-T11127 criterion 2: null ledger readings are stable but unnamed sources require rebuilding", t => {
  const f = fixture(t);
  f.view.ledgerReads = () => null;
  f.tick();
  f.tick();
  assert.equal(f.count(), 1);
  assert.equal(f.body().body.sources[0].asOf, null);
  const materialize = f.view.materialize;
  f.view.materialize = ctx => materialize(ctx).map(body => ({ ...body, sources: [
    ...body.sources, { name: "registry:repo", asOf: iso(ctx.now), state: "fresh" },
  ] }));
  f.append("core", "run.start");
  f.tick();
  f.tick();
  assert.equal(f.count(), 3, "the ledger reading cannot certify a file-backed source");
});

test("W1-T11127 criterion 2: a failed source store refresh prevents reuse", t => {
  const f = fixture(t);
  f.tick();
  assert.equal(f.ticker.acceptSnapshot({ instance: "core", ok: false, names: ["signals"], error: "fixture refresh failed", atMs: f.now() }), true);
  f.tick();
  f.tick();
  assert.equal(f.count(), 3);
  assert.equal(f.ticker.acceptSnapshot({ instance: "core", ok: true, asOf: iso(f.now()), bodies: [{ name: "signals", body: {} }] }), true);
  f.tick();
  f.tick();
  assert.equal(f.count(), 4, "a successful store refresh restores reuse");
});

test("W1-T11127 criterion 2: a cold instance builds independently and an unread skipped unit stays paced", t => {
  const f = fixture(t, ["core", "console"]);
  f.tick();
  f.tick();
  assert.equal(f.count(), 2);
  f.tick(READ_MODEL_READ_HOT_MS);
  f.append();
  f.tick(250);
  assert.equal(f.count(), 2, "the skipped checks retained the 100 ms build cost and stretched its wait");
  f.ticker.read("/v1/views/digest?instance=core");
  f.tick(1);
  assert.equal(f.count(), 3, "a read restores the unstretched due time");
});
