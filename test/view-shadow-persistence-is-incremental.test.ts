import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { openProjectorReadModel } from "#src/lib/ledger-projector.js";
import { acquireLease, attachReadModel, flushReadModelTransactions, openShadowCounterDb, READ_MODEL_BUSY_TIMEOUT_MS, releaseLease } from "#src/lib/read-model-db.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { createViewShadow, fileShadowStore, shadowReadiness, storedShadowReadiness, viewShadowPath, type ViewShadowState } from "#src/lib/view-shadow.js";
import { readShadowCounters, saveShadowCounter, shadowCounterPath } from "#src/lib/view-shadow-store.js";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const state = (keys: string[] = []): ViewShadowState => ({ requests: 2, firstRequestMs: NOW - 172800000, samples: 3000,
  diffs: { legacy_horizon: 0, timing: 0, dedupe: 0, real: 0 }, streakSamples: 3000, streakSinceMs: NOW - 172800000, lastRealMs: null, streakKeys: keys });
function fixture(t: TestContext) {
  const dir = makeTempDir("shadow-incremental"), clock = fixedClock(NOW);
  const db = openProjectorReadModel(dir, "core", clock), got = acquireLease(db, { clock });
  assert(got.ok);
  const stores: ReturnType<typeof fileShadowStore>[] = [];
  const holders: ReturnType<typeof counterHolder>[] = [];
  const path = viewShadowPath(dir);
  const store = () => { const s = fileShadowStore(path, db, got.lease); stores.push(s); return s; };
  t.after(async () => {
    for (const holder of holders) await holder.close();
    for (const s of stores) s.close?.();
    db.close();
    await flushReadModelTransactions();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, path, db, lease: got.lease, clock, store,
    hold: () => { const holder = counterHolder(shadowCounterPath(path), db.path); holders.push(holder); return holder; } };
}

/** A real separate writer retains its counter lock until explicit IPC release. */
function counterHolder(counter: string, home: string) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", String.raw`
    import { DatabaseSync } from 'node:sqlite';
    const counter = new DatabaseSync(process.argv[1], {timeout: 0});
    const home = new DatabaseSync(process.argv[2], {timeout: 0});
    let holding = false, probed = false, probeTimer;
    const send = row => process.send(row);
    function close() {
      clearTimeout(probeTimer);
      if (holding) counter.exec('ROLLBACK');
      holding = false; counter.close(); home.close(); process.disconnect();
    }
    function probe() {
      if (probed) return; probed = true; clearTimeout(probeTimer);
      let writable = true;
      try { home.exec('BEGIN IMMEDIATE'); home.exec('COMMIT'); }
      catch (error) {
        if (![5, 6].includes(error.errcode & 255)) throw error;
        writable = false;
      }
      send({type: 'probe', holding, writable});
    }
    process.on('message', message => {
      if (message === 'watch') {
        probed = false;
        // BACKSTOP: observe an old five-second wait while the parent is synchronously blocked.
        probeTimer = setTimeout(probe, 1000); send({type: 'watching'});
      } else if (message === 'saved') probe();
      else if (message === 'close') close();
    });
    // BACKSTOP for this owned private fixture child only; never a live worker.
    setTimeout(close, 30000).unref();
    counter.exec('BEGIN IMMEDIATE'); holding = true; send({type: 'held'});
  `, counter, home], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const rows: Array<{ type: string; holding?: boolean; writable?: boolean }> = [];
  let stderr = "";
  child.stderr!.on("data", bytes => { stderr = (stderr + String(bytes)).slice(-8192); });
  child.on("message", row => rows.push(row as typeof rows[number]));
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 && signal === null ? resolve() : reject(Error(`counter fixture exited ${code}/${signal}: ${stderr}`)));
  });
  // Handle early fixture failure immediately while retaining the rejection for cleanup.
  void exited.catch(() => {});
  const wait = (type: string) => {
    const row = rows.find(row => row.type === type);
    if (row) return Promise.resolve(row);
    return new Promise<typeof rows[number]>((resolve, reject) => {
      // BACKSTOP: bounded fixture IPC, not a product timeout.
      const timer = setTimeout(() => { child.off("message", listen); reject(Error(`counter fixture missing ${type}: ${stderr}`)); }, 8000);
      const listen = (row: unknown) => {
        if ((row as typeof rows[number]).type !== type) return;
        clearTimeout(timer); child.off("message", listen); resolve(row as typeof rows[number]);
      };
      child.on("message", listen);
    });
  };
  return { ready: () => wait("held"), watch: async () => { child.send("watch"); await wait("watching"); },
    saved: async () => { child.send("saved"); return wait("probe"); },
    close: async () => { if (child.connected) child.send("close"); await exited; } };
}

const isBusy = (error: unknown) => [5, 6].includes(((error as { errcode: number }).errcode) & 255);

test("W1-T10357: a contended shadow-counter open releases the home fence without waiting for its holder", async t => {
  const f = fixture(t), old = state(["committed"]);
  saveShadowCounter(f.path, {}, "v", old);
  const store = f.store(), holder = f.hold();
  await holder.ready(); await holder.watch();
  assert.throws(() => store.save("v", state(["uncommitted"])), isBusy);
  const probe = await holder.saved();
  assert.equal(probe.holding, true, "holder was never released to make the save succeed");
  assert.deepEqual(readShadowCounters(f.path, true)!.states.v, old, "counter and keys remain committed atomically");
  f.db.exec("BEGIN IMMEDIATE"); f.db.exec("COMMIT");
  await holder.close();
  store.save("v", state(["recovered"]));
  assert.deepEqual(readShadowCounters(f.path, true)!.states.v!.streakKeys, ["recovered"]);
  assert.equal(probe.writable, true, "independent observer must not find the home fence held through the counter's busy wait");
});

test("W1-T10357: a warmed shadow-counter refusal reconciles missed keys and resets", async t => {
  for (const reset of [false, true]) await t.test(reset ? "real-diff reset" : "key append", async t => {
    const f = fixture(t), store = f.store();
    store.save("v", state(["persisted"]));
    const shadow = createViewShadow({ clock: f.clock, log: () => {}, store,
      evidence: () => ({ legacyAsOfMs: null, viewAsOfMs: null, named: new Set(), namedBeforeHorizon: new Set(), namedInGap: new Set(), rowsInGap: 0, duplicateIds: new Set(), duplicateRows: 0 }) });
    assert.equal(shadow.readiness()[0]!.ready, true, "positive durable qualification control");
    const holder = f.hold(); await holder.ready(); await holder.watch();
    const sample = { view: "v", key: "lost", requests: 0, legacy: { data: 1, asOfMs: null }, body: { data: reset ? 2 : 1, asOf: null } };
    assert.throws(() => shadow.compare(sample), isBusy);
    const probe = await holder.saved();
    assert.equal(probe.holding, true);
    assert.equal(shadow.readiness()[0]!.ready, false);
    assert.match(shadow.readiness()[0]!.reason, /not committed/);
    assert.deepEqual(readShadowCounters(f.path, true)!.states.v!.streakKeys, ["persisted"]);
    await holder.close();
    shadow.compare({ ...sample, key: "committed", body: { data: 1, asOf: null } });
    assert.deepEqual(readShadowCounters(f.path, true)!.states.v!.streakKeys, reset ? ["committed"] : ["persisted", "lost", "committed"]);
    assert.deepEqual(storedShadowReadiness(f.path, f.db, NOW), shadow.readiness());
    assert.equal(probe.writable, true, "a warmed auxiliary writer must not transfer its wait into the projector");
  });
});

test("W1-T10357: counter-only refusal preserves lease fencing, durability and the projector busy backstop", t => {
  const f = fixture(t), path = shadowCounterPath(f.path);
  const value = (db: typeof f.db, name: string) => Object.values(db.prepare(`PRAGMA ${name}`).get()!)[0];
  assert.equal(value(f.db, "busy_timeout"), READ_MODEL_BUSY_TIMEOUT_MS);
  const attached = attachReadModel(f.db.path, f.db.schemaVersion);
  try { assert.equal(value(attached, "busy_timeout"), 5000); } finally { attached.close(); }
  f.store().save("v", state(["committed"]));
  const writer = openShadowCounterDb(path), reader = openShadowCounterDb(path, true);
  try {
    assert.equal(value(reader, "busy_timeout"), 5000);
    assert.equal(value(writer, "journal_mode"), "wal");
    assert.equal(value(writer, "synchronous"), 2);
    assert.equal(value(writer, "busy_timeout"), 0);
  } finally { reader.close(); writer.close(); }
  const before = readShadowCounters(f.path, true)!.states;
  assert.equal(releaseLease(f.db, f.lease), true);
  assert.throws(() => f.store().save("v", state(["forbidden"])), /lease_lost/);
  assert.deepEqual(readShadowCounters(f.path, true)!.states, before);
  const absent = join(f.dir, "never-created", "view-shadow.json");
  assert.throws(() => fileShadowStore(absent, f.db, f.lease).save("v", state()), /lease_lost/);
  assert.equal(existsSync(dirname(absent)), false, "lost lease refuses before any auxiliary file creation");
});

test("normalized shadow rows keep exact historical membership outside the hot counter payload", t => {
  const f = fixture(t), old = state(Array.from({ length: 10000 }, (_, n) => `section=archived&cursor=${n}-${"x".repeat(140)}`));
  writeFileSync(f.path, JSON.stringify({ inbox: old, retired: state(["historical"]) }));
  const bytes = readFileSync(f.path), before = statSync(f.path);
  const store = f.store(), current = store.load().inbox!;
  for (let n = 0; n < 12; n++) { current.samples++; current.streakSamples++; store.save("inbox", current, { reset: false, add: "new-cursor" }); }
  assert.equal(readFileSync(f.path).equals(bytes), true, "historical JSON bytes remain identical");
  assert.equal(statSync(f.path).mtimeMs, before.mtimeMs, "old evidence is preserved, not rewritten");
  const loaded = f.store().load();
  assert.equal(loaded.inbox!.samples, old.samples + 12);
  assert.deepEqual(loaded.inbox!.streakKeys, [...old.streakKeys!, "new-cursor"]);
  assert.deepEqual(loaded.retired, state(["historical"]));
  const compact = readShadowCounters(f.path, false)!;
  assert.equal(compact.keyCounts.get("inbox"), 10001);
  assert(compact.states.inbox!.streakKeys!.length === 0 && JSON.stringify(compact.states.inbox).length < 600, "hot counter payload excludes the historical key list");
});

test("shadow persistence preserves real-diff resets and generation refusals across a restart", t => {
  const f = fixture(t), evidence = { legacyAsOfMs: null, viewAsOfMs: null, named: new Set<string>(), namedBeforeHorizon: new Set<string>(), namedInGap: new Set<string>(), rowsInGap: 0, duplicateIds: new Set<string>(), duplicateRows: 0 };
  const make = () => createViewShadow({ clock: f.clock, log: () => {}, evidence: () => evidence, store: f.store(), qualifications: { v: "new" } });
  const sample = { view: "v", key: "k", requests: 1, qualificationGeneration: "new", legacy: { data: 1, asOfMs: null, qualificationGeneration: "new" }, body: { data: 1, asOf: null } };
  let shadow = make(); shadow.compare(sample); shadow.compare(sample);
  assert.equal(make().readiness()[0]!.keys, 1);
  shadow.compare({ ...sample, body: { data: 2, asOf: null } });
  shadow = make();
  assert.deepEqual([shadow.readiness()[0]!.streakSamples, shadow.readiness()[0]!.lastRealMs, shadow.readiness()[0]!.ready], [0, NOW, false]);
  shadow.compare({ ...sample, qualificationGeneration: undefined });
  assert.match(make().readiness()[0]!.reason, /requires both matched producers/);
  shadow.compare(sample);
  assert.deepEqual([make().readiness()[0]!.samples, make().readiness()[0]!.streakSamples], [4, 1]);
});

test("compact shadow readiness exactly matches full-key readiness, including qualified NUL keys", t => {
  const f = fixture(t), view = '\u0000qualification:["v","g"]', old = { ...state(["one", "two", "three"]), view: "v", qualificationGeneration: "g" };
  saveShadowCounter(f.path, {}, view, old);
  assert.deepEqual(storedShadowReadiness(f.path, f.db, NOW, { v: "g" }), [shadowReadiness("v", old, NOW)]);
  assert.deepEqual(readShadowCounters(f.path, true)!.states[view], old);
  assert.equal(storedShadowReadiness(f.path, f.db, NOW, { v: "other" })[0]!.ready, false);
});

test("a lost home lease cannot create, migrate, or change shadow evidence", t => {
  const f = fixture(t), store = f.store();
  assert.equal(releaseLease(f.db, f.lease), true);
  assert.throws(() => store.save("v", state(["x"])), /lease_lost/);
  assert.equal(existsSync(shadowCounterPath(f.path)), false);
});

test("shadow evidence corruption is UNKNOWN rather than fallback to an older ready receipt", t => {
  const f = fixture(t);
  writeFileSync(f.path, JSON.stringify({ v: state(["old"]) }));
  writeFileSync(shadowCounterPath(f.path), "not a database");
  assert.throws(() => storedShadowReadiness(f.path, f.db, NOW));
  assert.throws(() => f.store());
  assert.equal(readFileSync(shadowCounterPath(f.path), "utf8"), "not a database");
});

test("a visible but uninitialized shadow database is UNKNOWN, never an older ready receipt", t => {
  const f = fixture(t);
  writeFileSync(f.path, JSON.stringify({ v: state(["old"]) }));
  writeFileSync(shadowCounterPath(f.path), "");
  assert.throws(() => storedShadowReadiness(f.path, f.db, NOW), /no such table: meta/);
});

test("a foreign or future shadow schema is refused without recovery or legacy import", t => {
  const f = fixture(t), db = openShadowCounterDb(shadowCounterPath(f.path));
  db.prepare("UPDATE meta SET v='2' WHERE k='schema_version'").run(); db.close();
  assert.throws(() => readShadowCounters(f.path, true), /schema_mismatch/);
  assert.throws(() => saveShadowCounter(f.path, {}, "v", state()), /schema_mismatch/);
});

test("shadow migration commits counters and exact membership together and keeps table fallback", t => {
  const f = fixture(t), old = state(["old"]);
  f.db.exec("CREATE TABLE view_shadow(view TEXT PRIMARY KEY,state TEXT NOT NULL)");
  f.db.prepare("INSERT INTO view_shadow VALUES(?,?)").run("v", JSON.stringify(old));
  const store = f.store();
  assert.deepEqual(store.load().v, old);
  store.save("new", state(["new"]));
  assert.deepEqual(f.store().load(), { v: old, new: state(["new"]) });
  const current = state(); delete current.streakKeys;
  store.save("new", current);
  assert.equal(f.store().load().new!.streakKeys, undefined);
});

test("shadow migration and append failures do not manufacture an initialized store", t => {
  const f = fixture(t), broken = state();
  Object.defineProperty(broken, "samples", { get() { throw Error("serialize failed"); } });
  assert.throws(() => saveShadowCounter(f.path, { broken }, "v", state()), /serialize failed/);
  assert.throws(() => readShadowCounters(f.path, true), /migration is not committed/);
  saveShadowCounter(f.path, {}, "v", state(["x"]));
  assert.deepEqual(readShadowCounters(f.path, true)!.states.v!.streakKeys, ["x"]);
});

test("shadow counters are persistent siblings and never follow the scratch DB mapping", t => {
  const f = fixture(t), prior = process.env.RMD_READ_MODEL_DB_DIR;
  process.env.RMD_READ_MODEL_DB_DIR = `${f.dir}:${join(f.dir, "scratch")}`;
  try { f.store().save("v", state(["x"])); }
  finally { if (prior === undefined) delete process.env.RMD_READ_MODEL_DB_DIR; else process.env.RMD_READ_MODEL_DB_DIR = prior; }
  assert(existsSync(shadowCounterPath(f.path)));
  assert.equal(existsSync(join(f.dir, "scratch", "view-shadow.json.sqlite")), false);
});

test("unusable shadow directories refuse without a success-shaped counter result", t => {
  const f = fixture(t), bad = join(f.dir, "not-directory", "view-shadow.json");
  writeFileSync(dirname(bad), "owned fixture");
  assert.throws(() => readShadowCounters(bad, true));
  assert.throws(() => saveShadowCounter(bad, {}, "v", state()));
});

test("the comparator closes its persistent writer and refuses a save after closure", t => {
  const f = fixture(t), store = f.store();
  store.save("v", state(["x"]));
  const shadow = createViewShadow({ store, log: () => {}, evidence: () => { throw Error("unused"); } });
  shadow.close(); shadow.close();
  assert.throws(() => store.save("v", state(["bad"])), /closed/);
  assert.deepEqual(readShadowCounters(f.path, true)!.states.v!.streakKeys, ["x"]);
});

test("uncommitted in-memory shadow counters cannot authorize readiness after a save failure", () => {
  let fail = true;
  const measured = state(["k"]);
  assert.equal(shadowReadiness("v", measured, NOW).ready, true, "positive old ready control");
  const shadow = createViewShadow({ clock: fixedClock(NOW), log: () => {},
    store: { load: () => ({ v: measured }), save: () => { if (fail) throw Error("owned fixture write failed"); } },
    evidence: () => ({ legacyAsOfMs: null, viewAsOfMs: null, named: new Set(), namedBeforeHorizon: new Set(), namedInGap: new Set(), rowsInGap: 0, duplicateIds: new Set(), duplicateRows: 0 }) });
  const sample = { view: "v", key: "k", requests: 0, legacy: { data: 1, asOfMs: null }, body: { data: 1, asOf: null } };
  assert.throws(() => shadow.compare(sample), /owned fixture write failed/);
  assert.equal(shadow.readiness()[0]!.ready, false);
  assert.match(shadow.readiness()[0]!.reason, /not committed/);
  fail = false;
  shadow.compare(sample);
  assert.equal(shadow.readiness()[0]!.ready, true, "only a successful commit resumes measured qualification");
});

for (const reset of [false, true]) test(`a successful shadow save reconciles a previously failed ${reset ? "real-diff reset" : "key append"}`, t => {
  const f = fixture(t), store = f.store();
  store.save("v", state(["persisted"]));
  let fail = true;
  const shadow = createViewShadow({ clock: f.clock, log: () => {},
    store: { load: store.load, save: (view, value, keys) => { if (fail) throw Error("owned fixture transient save failure"); store.save(view, value, keys); } },
    evidence: () => ({ legacyAsOfMs: null, viewAsOfMs: null, named: new Set(), namedBeforeHorizon: new Set(), namedInGap: new Set(), rowsInGap: 0, duplicateIds: new Set(), duplicateRows: 0 }) });
  const sample = { view: "v", key: "lost", requests: 0, legacy: { data: 1, asOfMs: null }, body: { data: reset ? 2 : 1, asOf: null } };
  assert.throws(() => shadow.compare(sample), /owned fixture transient save failure/);
  assert.equal(shadow.readiness()[0]!.ready, false);
  assert.deepEqual(readShadowCounters(f.path, true)!.states.v!.streakKeys, ["persisted"], "failed transaction did not change durable membership");
  fail = false;
  shadow.compare({ ...sample, key: "committed", body: { data: 1, asOf: null } });
  const expected = reset ? ["committed"] : ["persisted", "lost", "committed"];
  assert.deepEqual(readShadowCounters(f.path, true)!.states.v!.streakKeys, expected, "recovery reconciles every earlier append or reset before resuming incremental persistence");
  assert.deepEqual(storedShadowReadiness(f.path, f.db, NOW), shadow.readiness(), "cold and current-owner readiness retain the same denominator");
});
