import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ReadModelDb } from "#src/lib/read-model-db.js";
import { publishThreadPlan } from "#src/lib/thread-plan.js";
import {
  createReadModelTicker, ledgerSource, READ_MODEL_READ_HOT_MS, readModelSwitchesPath,
  type ReadModelView, type ReadModelWorkerMessage,
} from "#src/lib/read-model-worker.js";
import { closeReadModelFixture, readModelFixtureDir } from "#test/helpers/read-model-fixture.js";

const START = Date.parse("2026-11-02T12:00:00Z");
const iso = (at: number): string => new Date(at).toISOString();

function fixture(t: TestContext, names = ["core"]) {
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
  const view: ReadModelView = {
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
    writeFileSync(switchesPath, JSON.stringify({ projector: "on", views: { digest: "serve" }, push }));
    utimesSync(switchesPath, new Date(now), new Date(now));
  };
  switches();
  const ticker = createReadModelTicker({
    stateDir: dir, instances, views: [view], oracle: "off", holder: "digest-test",
    clock: { now: () => now, date: () => new Date(now), iso: () => iso(now) },
    post: message => { messages.push(message); },
  });
  closeReadModelFixture(t, () => ticker.release());
  ticker.start();
  const tick = (ms = 1_000) => { now += ms; ticker.tick(); };
  const append = (name = "core", step = "daemon.tick") => {
    appendFileSync(join(dir, name, "ledger.ndjson"), JSON.stringify({ ts: iso(now), step }) + "\n");
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
