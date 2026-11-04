import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { openProjectorReadModel } from "#src/lib/ledger-projector.js";
import { acquireLease, flushReadModelTransactions, openShadowCounterDb } from "#src/lib/read-model-db.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { createViewShadow, fileShadowStore, viewShadowPath } from "#src/lib/view-shadow.js";
import { readShadowCounters, SHADOW_KEY_COUNT_SQL, SHADOW_KEY_RETIRE_MS, shadowCounterPath, shadowKeyRetireBatch } from "#src/lib/view-shadow-store.js";

const START = Date.parse("2026-11-01T00:00:00Z");
const DAY = SHADOW_KEY_RETIRE_MS;
const evidence = { legacyAsOfMs: null, viewAsOfMs: null, named: new Set<string>(), namedBeforeHorizon: new Set<string>(), namedInGap: new Set<string>(), rowsInGap: 0, duplicateIds: new Set<string>(), duplicateRows: 0 };

/** A real home read model and shadow store in a tmp dir, with a clock the test moves. */
function fixture(t: TestContext) {
  const dir = makeTempDir("shadow-key-bound");
  let now = START;
  const clock = clockFromMillisFn(() => now);
  const db = openProjectorReadModel(dir, "core", clock), got = acquireLease(db, { clock });
  assert(got.ok);
  const path = viewShadowPath(dir);
  const stores: ReturnType<typeof fileShadowStore>[] = [];
  const shadow = () => {
    const store = fileShadowStore(path, db, got.lease, undefined, clock);
    stores.push(store);
    return createViewShadow({ clock, log: () => {}, evidence: () => evidence, store });
  };
  t.after(async () => {
    for (const store of stores) store.close?.();
    db.close();
    await flushReadModelTransactions();
    rmSync(dir, { recursive: true, force: true });
  });
  const sample = (s: ReturnType<typeof shadow>, key: string, data = 1) =>
    s.compare({ view: "counter", key, requests: 1, legacy: { data: 1, asOfMs: null }, body: { data, asOf: null } });
  const stored = () => readShadowCounters(path, false)!.keyCounts.get("counter") ?? 0;
  const storedKeys = () => readShadowCounters(path, true)!.states.counter!.streakKeys!;
  /** The stored keys of `counter` that are expired, and live, at `atMs`, read straight from the file. */
  const split = (atMs: number) => {
    const raw = new DatabaseSync(shadowCounterPath(path), { readOnly: true });
    try {
      const n = (sql: string) => Number(raw.prepare(sql).get("counter", atMs - DAY)?.n ?? 0);
      return { expired: n("SELECT count(*) AS n FROM shadow_key WHERE view = ? AND last_ms <= ?"), live: n("SELECT count(*) AS n FROM shadow_key WHERE view = ? AND last_ms > ?") };
    } finally { raw.close(); }
  };
  return { path, shadow, sample, stored, storedKeys, split, at: (ms: number) => { now = ms; } };
}

test("W1-T11330: 10,000 one-off keys sampled across simulated days stay bounded by the keys sampled within the last day", t => {
  const f = fixture(t), shadow = f.shadow();
  const perDay = 2_000, days = 5;
  const sampledAt: number[] = [];
  for (let day = 0; day < days; day++) {
    for (let i = 0; i < perDay; i++) {
      const at = START + day * DAY + Math.floor((i * DAY) / perDay);
      f.at(at);
      f.sample(shadow, `snapshot-${day}-${i}`);
      sampledAt.push(at);
      if (i % 500 === 499) {
        // Every key sampled within the last day is still a member; every older one has retired.
        const live = sampledAt.filter(ms => at - ms < DAY).length;
        assert.equal(f.stored(), live, `stored membership at day ${day} sample ${i}`);
        assert.equal(shadow.readiness()[0]!.keys, live, `readiness counts only the live keys at day ${day} sample ${i}`);
      }
    }
  }
  assert(f.stored() <= perDay, `${f.stored()} stored keys after ${days * perDay} one-off samples`);
});

test("W1-T11330: a key re-sampled daily stays and keeps owing its cadence, while a one-off key retires after a day", t => {
  const f = fixture(t), shadow = f.shadow();
  f.sample(shadow, "daily");
  f.sample(shadow, "once");
  for (let day = 1; day <= 3; day++) {
    f.at(START + day * DAY - 60_000);
    f.sample(shadow, "daily");
  }
  assert.deepEqual(f.storedKeys(), ["daily"]);
  const readiness = shadow.readiness()[0]!;
  assert.equal(readiness.keys, 1);
  assert.equal(readiness.requiredSamples, DAY / 60_000, "the key still requested owes a full day of one-per-minute samples");
  // A restart reloads the stored times: the daily key is still live, so a later sample of it is no new member.
  const restarted = f.shadow();
  f.sample(restarted, "daily");
  assert.deepEqual([f.stored(), restarted.readiness()[0]!.keys], [1, 1]);
});

test("W1-T11330: a real diff still empties the streak's key set", t => {
  const f = fixture(t), shadow = f.shadow();
  for (const key of ["a", "b", "c"]) f.sample(shadow, key);
  assert.equal(f.stored(), 3);
  f.at(START + 60_000);
  f.sample(shadow, "a", 2);
  assert.deepEqual([f.stored(), shadow.readiness()[0]!.streakSamples], [0, 0]);
  f.at(START + 120_000);
  f.sample(shadow, "d");
  assert.deepEqual(f.storedKeys(), ["d"]);
});

test("W1-T11330 criterion 2: loading counts each view's keys from the maintained count, never a GROUP BY scan of shadow_key", t => {
  const f = fixture(t), shadow = f.shadow();
  for (const key of ["a", "b", "c"]) f.sample(shadow, key);
  const raw = new DatabaseSync(shadowCounterPath(f.path));
  try {
    const plan = raw.prepare(`EXPLAIN QUERY PLAN ${SHADOW_KEY_COUNT_SQL}`).all().map(row => String(row.detail));
    assert(plan.length > 0, "the plan names at least one step");
    assert(plan.every(step => !/\bshadow_key\b(?!_count)/.test(step) && !/GROUP BY/.test(step)), `load plan: ${plan.join(" | ")}`);
    // The load reports the count the saves maintained: a row written behind the store's back is not re-counted.
    raw.prepare("INSERT INTO shadow_key(view,key,ordinal,last_ms) VALUES('counter','stray',99,?)").run(START);
  } finally { raw.close(); }
  assert.equal(f.stored(), 3);
});

/** A store an older build wrote: `keys` members with no sample times, and no count table. */
function seedLegacyStore(path: string, keys: number): void {
  const old = openShadowCounterDb(shadowCounterPath(path));
  try {
    old.exec("BEGIN IMMEDIATE");
    const state = { requests: keys, firstRequestMs: START - DAY, samples: keys, diffs: { legacy_horizon: 0, timing: 0, dedupe: 0, real: 0 }, streakSamples: keys, streakSinceMs: START - DAY, lastRealMs: null, streakKeys: [] };
    old.prepare("INSERT INTO shadow_counter(view,state) VALUES('counter',?)").run(JSON.stringify(state));
    const add = old.prepare("INSERT INTO shadow_key(view,key,ordinal) VALUES('counter',?,?)");
    for (let i = 0; i < keys; i++) add.run(`cursor-${i}`, i);
    old.prepare("INSERT INTO meta(k,v) VALUES('shadow_migrated','1')").run();
    old.exec("COMMIT");
  } finally { old.close(); }
}

test("W1-T11330: sparse traffic after a burst drains: 100 keys, then one new key a day for ten days, converges to the live keys", t => {
  const f = fixture(t), shadow = f.shadow();
  for (let i = 0; i < 100; i++) { f.at(START + i * 60_000); f.sample(shadow, `burst-${i}`); }
  assert.equal(f.stored(), 100);
  let at = START + 99 * 60_000;
  for (let day = 1; day <= 10; day++) {
    at += DAY + 60_000;
    f.at(at);
    f.sample(shadow, `sparse-${day}`);
    // Only the key just sampled was sampled within the last day.
    assert.deepEqual([f.stored(), shadow.readiness()[0]!.keys], [1, 1], `day ${day}: stored and readiness keys`);
  }
  assert.deepEqual(f.storedKeys(), ["sparse-10"]);
});

test("W1-T11330 criterion 2: an older build's keys are stamped at load time, so a save more than a day after the load prunes them", t => {
  const f = fixture(t);
  seedLegacyStore(f.path, 100);
  assert.equal(f.stored(), 100, "an unupgraded store still counts its membership");
  const shadow = f.shadow();
  f.at(START + DAY + 60_000);
  f.sample(shadow, "first-after-upgrade");
  assert.deepEqual([f.stored(), shadow.readiness()[0]!.keys], [1, 1]);
  assert.deepEqual(f.storedKeys(), ["first-after-upgrade"]);
});

test("W1-T11330 criterion 2: an upgraded oversized membership drains in bounded batches, shrinking on every save", t => {
  const f = fixture(t), backlog = 3_000, traffic = 50;
  seedLegacyStore(f.path, backlog);
  const shadow = f.shadow();
  // Live traffic before the legacy keys expire: each key sampled once, a minute apart.
  for (let i = 0; i < traffic; i++) { f.at(START + DAY - (traffic - i) * 60_000); f.sample(shadow, `live-${i}`); }
  assert.equal(f.stored(), backlog + traffic, "nothing retires before a day after the load");
  let saves = 0, drainedAt = START + DAY;
  for (let i = 0; f.split(START + DAY + (i + 1) * 60_000).expired > 0; i++) {
    const at = START + DAY + (i + 1) * 60_000, before = f.split(at);
    drainedAt = at;
    f.at(at);
    f.sample(shadow, `live-${i % traffic}`);
    const after = f.split(at), retired = before.expired - after.expired;
    assert(retired > 0, `save ${i}: the expired backlog strictly shrinks (${before.expired} -> ${after.expired})`);
    assert(retired <= shadowKeyRetireBatch(before.live, before.expired, 0), `save ${i} retired ${retired}, above its data-derived batch`);
    assert(retired <= Math.max(before.live, Math.ceil(before.expired / before.live)), `save ${i}: the batch is bounded by max(live, expired / live)`);
    saves++;
  }
  assert(saves > 1, `the backlog drained over ${saves} saves, not in one unbounded delete`);
  assert(drainedAt - (START + DAY) < DAY, `the backlog drained ${drainedAt - (START + DAY)} ms after it expired, inside a day of the view's own traffic`);
  assert.equal(f.stored(), traffic);
});

test("W1-T11330 criterion 2: every save's retirement batch exceeds its own inserts, so a backlog never holds steady", () => {
  for (const [live, expired, inserted] of [[1, 100, 1], [1, 100, 0], [0, 5, 1], [50, 3000, 1], [3, 2, 7]] as const) {
    const batch = shadowKeyRetireBatch(live, expired, inserted);
    assert(batch > inserted, `live ${live}, expired ${expired}, inserted ${inserted}: batch ${batch}`);
    assert(batch >= Math.ceil(expired / Math.max(1, live)), `batch ${batch} covers the backlog's share of the next day's ${live} save(s)`);
  }
});
