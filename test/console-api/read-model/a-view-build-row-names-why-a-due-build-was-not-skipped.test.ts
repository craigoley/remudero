import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ReadModelDb } from "#src/lib/read-model-db.js";
import { createDemandBook } from "#src/lib/view-demand.js";
import {
  createReadModelTicker, ledgerSource, READ_MODEL_READ_HOT_MS, readModelLaneViews, readModelSwitchesPath,
  type ReadModelView, type ReadModelWorkerMessage,
} from "#src/lib/read-model-worker.js";
import { closeReadModelFixture, readModelFixtureDir } from "#test/helpers/read-model-fixture.js";

const START = Date.parse("2026-11-10T12:00:00Z");
const WINDOW_MS = 10 * 60_000;
const iso = (at: number): string => new Date(at).toISOString();

/** One ticker over real stores. `production` builds the lane's own read-model view; otherwise a fixture view that declares the daemon heartbeat. */
function fixture(t: TestContext, production = false) {
  const dir = readModelFixtureDir(t, "why-not-skipped");
  const planPath = join(dir, "plan.yaml");
  writeFileSync(planPath, "tasks: []\n");
  const ledgerDir = join(dir, "core");
  mkdirSync(ledgerDir);
  writeFileSync(join(ledgerDir, "ledger.ndjson"), JSON.stringify({ ts: iso(START), step: "daemon.tick" }) + "\n");
  const instances = [{ name: "core", ledgerDir, planPath }];
  let now = START;
  let materialized = 0;
  let extraSource = false;
  const stores = new Map<string, ReadModelDb>();
  const messages: ReadModelWorkerMessage[] = [];
  const clock = { now: () => now, date: () => new Date(now), iso: () => iso(now) };
  const laneView = readModelLaneViews({ instances }, clock, () => {}, createDemandBook({ clock })).find(view => view.name === "read-model")!;
  assert.ok(!("create" in laneView));
  const view: ReadModelView = production ? laneView : {
    name: "digest", version: 1,
    ledgerReads: db => {
      const beat = db.prepare("SELECT last_ms FROM instance_heartbeat WHERE k = 'daemon'").get();
      return beat ? iso(Number(beat.last_ms)) : null;
    },
    legacy: (_key, at, data) => ({ data, asOfMs: at }),
    materialize: ctx => {
      materialized++;
      now += 100;
      return ctx.instances.map(({ state, db }) => {
        assert.ok(db);
        stores.set(state.instance, db);
        return { key: "", data: { serial: materialized }, sources: [
          ledgerSource(state, ctx.now), { name: `plan:${state.instance}`, asOf: iso(ctx.now), state: "fresh" as const },
          ...(extraSource ? [{ name: "registry:repo", asOf: iso(ctx.now), state: "fresh" as const }] : []),
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
    stateDir: dir, instances, views: [view], oracle: "off", holder: "why-test", clock,
    post: message => { messages.push(message); },
  });
  closeReadModelFixture(t, () => ticker.release());
  ticker.start();
  const tick = (ms = 1_000) => { now += ms; ticker.tick(); };
  let reported = 0;
  return {
    ticker, view, stores, planPath, tick, switches,
    count: () => materialized, now: () => now,
    extraSource: (value: boolean) => { extraSource = value; },
    append: (step = "daemon.tick", at = now) => {
      appendFileSync(join(ledgerDir, "ledger.ndjson"), JSON.stringify({ ts: iso(at), step }) + "\n");
    },
    body: () => {
      const message = messages.filter(m => m.type === "body").at(-1);
      assert.ok(message?.type === "body");
      return message.entry;
    },
    state: () => {
      const message = messages.filter(m => m.type === "state").at(-1);
      assert.ok(message?.type === "state");
      return message.instances[0]!;
    },
    /** Closes the ten-minute window with one more due call and returns the row it ledgers for this view. */
    row: () => {
      tick(WINDOW_MS);
      const rows = messages.flatMap(m => m.type === "log" && m.step === "read_model.view_builds" && m.extra.view === view.name ? [m.extra] : []);
      assert.equal(rows.length, reported + 1, "one row per window");
      const row = rows[reported++]!;
      const reasons = Object.values((row.not_skipped ?? {}) as Record<string, number>).reduce((sum, count) => sum + count, 0);
      assert.equal(reasons + Number(row.skipped ?? 0), row.calls, "every call is a skip or has exactly one reason");
      return row;
    },
  };
}

test("W1-T11974 criterion 1: a build of a view that declares no ledger reads is counted under no_declaration", t => {
  const f = fixture(t);
  delete f.view.ledgerReads;
  f.tick();
  f.tick();
  f.append("run.start");
  f.tick();
  const row = f.row();
  assert.equal(f.count(), 4, "an undeclared view builds on every due call");
  assert.deepEqual(row.not_skipped, { no_declaration: 4 }, "every build names the missing declaration and no other cause");
  assert.equal(row.calls, 4);
  assert.equal(row.builds, 4);
  assert.equal(row.skipped, undefined);
});

test("W1-T11974 criterion 2: a build is counted under the first digest part that differs from the last successful build", t => {
  const f = fixture(t);
  f.tick();
  f.tick();
  assert.deepEqual(f.row().not_skipped, { no_previous: 1 }, "the cold build had no earlier digest to compare with");

  f.append();
  f.tick();
  assert.deepEqual(f.row().not_skipped, { ledger: 1 }, "a declared row moved; the store generation moved too, and the earlier part is the one named");

  writeFileSync(f.planPath, "tasks: []\n# changed plan\n");
  f.append("run.start");
  f.tick();
  assert.deepEqual(f.row().not_skipped, { plan: 1 }, "the plan and the generation moved; the plan comes first");

  f.append("run.start");
  f.tick();
  assert.deepEqual(f.row().not_skipped, { generation: 1 }, "only an undeclared row moved the store generation");

  assert.equal(f.ticker.acceptSnapshot({ instance: "core", ok: true, asOf: iso(f.now()), bodies: [{ name: "signals", body: {} }] }), true);
  f.tick();
  assert.deepEqual(f.row().not_skipped, { snapshot: 1 });

  f.switches("on");
  f.tick(5_000);
  assert.deepEqual(f.row().not_skipped, { switches: 1 });

  assert.equal(f.ticker.shadow({ view: "digest", key: "", requests: 1 }), true, "the comparator sampled the body");
  f.tick();
  assert.deepEqual(f.row().not_skipped, { shadow: 1 }, "the shadow readiness the context carries moved");

  const state = f.state();
  const before = f.count();
  f.ticker.observe([{ ...state, heldBy: "observer" }]);
  f.ticker.buildNow("digest");
  assert.equal(f.count(), before + 1);
  assert.deepEqual(f.row().not_skipped, { state: 2 }, "the observed holder moved the state part, and the closing tick's own reading moved it back");
});

test("W1-T11974 criterion 3: an unreadable digest is counted under unreadable, a skip only under skipped, and the body and due time are unchanged", t => {
  const f = fixture(t);
  f.tick();
  const built = f.body();
  for (let i = 0; i < 4; i++) f.tick();
  const skips = f.row();
  assert.equal(f.count(), 1, "five due calls after the cold build ran no materialize");
  assert.equal(f.body(), built, "a skipped call keeps the body, its ETag and generatedAt");
  assert.equal(skips.skipped, 5);
  assert.deepEqual(skips.not_skipped, { no_previous: 1 }, "the five skips appear under no build reason");
  assert.equal(skips.calls, 6);
  assert.equal(skips.builds, 1);

  f.tick();
  const onlySkips = f.row();
  assert.equal(onlySkips.skipped, 2);
  assert.equal(onlySkips.not_skipped, undefined, "a window of skips alone carries no build reason");

  const db = f.stores.get("core")!;
  const meta = db.meta;
  t.after(() => { db.meta = meta; });
  db.meta = key => key === "generation" ? undefined : meta(key);
  f.ticker.buildNow("digest");
  db.meta = key => {
    if (key === "generation") throw new Error("fixture generation unreadable");
    return meta(key);
  };
  f.ticker.buildNow("digest");
  db.meta = meta;
  f.ticker.buildNow("digest");
  f.ticker.buildNow("digest");
  assert.equal(f.count(), 4, "both unreadable digests built, the next call built against no digest, and the one after it was skipped");
  const row = f.row();
  assert.deepEqual(row.not_skipped, { unreadable: 2, no_previous: 1 });
  assert.equal(row.skipped, 2);
  assert.equal(row.calls, 5, "every call is a skip or has exactly one reason");

  // The due time: a skipped unit keeps its last build cost (100 ms), so its wait is that cost over the view share.
  const paced = fixture(t);
  paced.view.readPaced = true;
  paced.tick();
  paced.tick();
  paced.tick(READ_MODEL_READ_HOT_MS);
  paced.append();
  paced.tick(250);
  assert.equal(paced.count(), 1, "the skipped checks kept the 100 ms cost and the unread unit's stretched wait");
  paced.ticker.read("/v1/views/digest");
  paced.tick(1);
  assert.equal(paced.count(), 2, "a read restores the unstretched due time");
});

test("W1-T11974 criterion 4: a source the digest cannot certify is counted under sources, a first build under no_previous, and reasons plus skips equal calls", t => {
  const f = fixture(t);
  f.extraSource(true);
  f.tick();
  f.tick();
  f.tick();
  const row = f.row();
  assert.equal(f.count(), 4);
  assert.deepEqual(row.not_skipped, { no_previous: 1, sources: 3 }, "the file-backed source, not a moved part, defeated the skip");
});

test("W1-T11974 criterion 5: the production read-model view ledgers its reasons through the lane registration, with nothing injected", t => {
  const f = fixture(t, true);
  f.tick();
  f.tick();
  f.append("run.start");
  f.tick();
  const row = f.row();
  assert.equal(row.view, "read-model");
  assert.deepEqual(row.not_skipped, { no_previous: 1, generation: 1 });
  assert.equal(row.skipped, 2);
  assert.equal(row.calls, 4);
});
