import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import { openProjectorReadModel } from "../src/lib/ledger-projector.js";
import { acquireLease, openShadowCounterDb, releaseLease } from "../src/lib/read-model-db.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { createViewShadow, fileShadowStore, shadowReadiness, storedShadowReadiness, viewShadowPath, type ViewShadowState } from "../src/lib/view-shadow.js";
import { readShadowCounters, saveShadowCounter, shadowCounterPath } from "../src/lib/view-shadow-store.js";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const state = (keys: string[] = []): ViewShadowState => ({ requests: 2, firstRequestMs: NOW - 172800000, samples: 3000,
  diffs: { legacy_horizon: 0, timing: 0, dedupe: 0, real: 0 }, streakSamples: 3000, streakSinceMs: NOW - 172800000, lastRealMs: null, streakKeys: keys });
function fixture(t: TestContext) {
  const dir = makeTempDir("shadow-incremental"), clock = fixedClock(NOW);
  const db = openProjectorReadModel(dir, "core", clock), got = acquireLease(db, { clock });
  assert(got.ok);
  const stores: ReturnType<typeof fileShadowStore>[] = [];
  const path = viewShadowPath(dir);
  const store = () => { const s = fileShadowStore(path, db, got.lease); stores.push(s); return s; };
  t.after(() => { for (const s of stores) s.close?.(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, path, db, lease: got.lease, clock, store };
}

test("shadow persistence retains historical keys without rewriting their JSON on each sample", t => {
  const f = fixture(t), old = state(Array.from({ length: 10000 }, (_, n) => `section=archived&cursor=${n}-${"x".repeat(140)}`));
  writeFileSync(f.path, JSON.stringify({ inbox: old, retired: state(["historical"]) }));
  const bytes = readFileSync(f.path), before = statSync(f.path);
  const store = f.store(), current = store.load().inbox!;
  for (let n = 0; n < 12; n++) { current.samples++; current.streakSamples++; store.save("inbox", current, { reset: false, add: "new-cursor" }); }
  assert.deepEqual(readFileSync(f.path), bytes);
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
  assert.equal(readShadowCounters(f.path, true), undefined);
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
