import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { openProjectorReadModel } from "#src/lib/ledger-projector.js";
import { acquireLease, flushReadModelTransactions, openShadowCounterDb } from "#src/lib/read-model-db.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { createViewShadow, fileShadowStore, viewShadowPath } from "#src/lib/view-shadow.js";
import { readShadowCounters, SHADOW_KEY_COUNT_SQL, SHADOW_KEY_RETIRE_MS, shadowCounterPath } from "#src/lib/view-shadow-store.js";

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
    const store = fileShadowStore(path, db, got.lease);
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
  return { path, shadow, sample, stored, storedKeys, at: (ms: number) => { now = ms; } };
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

test("W1-T11330 criterion 2: the first save after upgrade prunes an existing oversized membership in bounded batches", t => {
  const f = fixture(t), backlog = 3_000;
  // A store an older build wrote: membership with no sample times, and no count table.
  const old = openShadowCounterDb(shadowCounterPath(f.path));
  try {
    old.exec("BEGIN IMMEDIATE");
    const state = { requests: backlog, firstRequestMs: START - DAY, samples: backlog, diffs: { legacy_horizon: 0, timing: 0, dedupe: 0, real: 0 }, streakSamples: backlog, streakSinceMs: START - DAY, lastRealMs: null, streakKeys: [] };
    old.prepare("INSERT INTO shadow_counter(view,state) VALUES('counter',?)").run(JSON.stringify(state));
    const add = old.prepare("INSERT INTO shadow_key(view,key,ordinal) VALUES('counter',?,?)");
    for (let i = 0; i < backlog; i++) add.run(`cursor-${i}`, i);
    old.prepare("INSERT INTO meta(k,v) VALUES('shadow_migrated','1')").run();
    old.exec("COMMIT");
  } finally { old.close(); }
  assert.equal(f.stored(), backlog, "an unupgraded store still counts its membership");

  const shadow = f.shadow();
  f.sample(shadow, "first-after-upgrade");
  assert.equal(f.stored(), backlog + 1, "the upgrade stamps existing keys with its own time, so none retires before a day");

  let previous = f.stored(), saves = 0, live = 1;
  for (let i = 0; f.stored() > live; i++) {
    f.at(START + DAY + (i + 1) * 60_000);
    f.sample(shadow, `fresh-${i}`);
    live = i + 1;
    const now = f.stored(), retired = previous + 1 - now;
    assert(now <= previous, `save ${i}: the stored set never grows while a retired key remains (${previous} -> ${now})`);
    assert(retired <= Math.max(1, live), `save ${i} retired ${retired}, more than the ${live} live key(s) that bound one batch`);
    previous = now;
    saves++;
    assert(saves < backlog, "the backlog drains");
  }
  assert(saves > 1, `the backlog drained over ${saves} saves, not in one unbounded delete`);
  assert.equal(f.stored(), live);
});
