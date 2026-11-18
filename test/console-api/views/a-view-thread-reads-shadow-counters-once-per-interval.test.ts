import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { openProjectorReadModel } from "#src/lib/ledger-projector.js";
import { flushReadModelTransactions, type ReadModelDb } from "#src/lib/read-model-db.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { STORED_READINESS_REFRESH_MS, storedShadowReadiness, storedShadowReadinessReader, viewShadowPath, type ViewShadowState } from "#src/lib/view-shadow.js";
import { readShadowCounters, saveShadowCounter } from "#src/lib/view-shadow-store.js";

const NOW = Date.parse("2026-11-17T12:00:00Z");
const DAY = 86_400_000;
const state = (streakSamples: number): ViewShadowState => ({ requests: 2, firstRequestMs: NOW - 2 * DAY, samples: streakSamples,
  diffs: { legacy_horizon: 0, timing: 0, dedupe: 0, real: 0 }, streakSamples, streakSinceMs: NOW - 2 * DAY, lastRealMs: null, streakKeys: [] });

function fixture(t: TestContext) {
  const dir = makeTempDir("shadow-readiness-reader");
  let ms = NOW;
  const clock = clockFromMillisFn(() => ms);
  const db = openProjectorReadModel(dir, "core", clock);
  const path = viewShadowPath(dir);
  t.after(async () => { db.close(); await flushReadModelTransactions(); rmSync(dir, { recursive: true, force: true }); });
  let reads = 0;
  const counting: typeof readShadowCounters = (...args) => { reads += 1; return readShadowCounters(...args); };
  return { db, path, clock, counting, reads: () => reads, advance: (by: number) => { ms += by; } };
}

test("W1-T13536 criterion 1: passes inside the refresh interval reuse one read of the counter store, and readiness is still computed at each pass's now", (t) => {
  const f = fixture(t);
  saveShadowCounter(f.path, {}, "v", state(10));
  const reader = storedShadowReadinessReader(f.clock, STORED_READINESS_REFRESH_MS, f.counting);
  const first = reader(f.path, f.db, NOW);
  assert.deepEqual(first, storedShadowReadiness(f.path, f.db, NOW));
  for (let pass = 1; pass < 40; pass++) {
    f.advance(250);
    assert.deepEqual(reader(f.path, f.db, NOW + pass * 250), storedShadowReadiness(f.path, f.db, NOW + pass * 250));
  }
  assert.equal(f.reads(), 1, "40 passes at 250 ms read the store once");
  assert.equal(reader(f.path, f.db, NOW - DAY)[0]!.reason, storedShadowReadiness(f.path, f.db, NOW - DAY)[0]!.reason, "an earlier now is judged at that now");
});

test("W1-T13536 criterion 2: the store is read again once the interval passes, when the qualifications change, and when the clock goes back", (t) => {
  const f = fixture(t);
  saveShadowCounter(f.path, {}, "v", state(10));
  const reader = storedShadowReadinessReader(f.clock, STORED_READINESS_REFRESH_MS, f.counting);
  reader(f.path, f.db, NOW);
  saveShadowCounter(f.path, {}, "v", state(20));
  f.advance(STORED_READINESS_REFRESH_MS - 1);
  assert.match(reader(f.path, f.db, NOW)[0]!.reason, /^zero real diffs|10 of/, "inside the interval the earlier read stands");
  assert.equal(f.reads(), 1);
  f.advance(1);
  assert.deepEqual(reader(f.path, f.db, NOW), storedShadowReadiness(f.path, f.db, NOW), "at the interval the new save shows");
  assert.match(reader(f.path, f.db, NOW)[0]!.reason, /20 of/);
  assert.equal(f.reads(), 2);
  reader(f.path, f.db, NOW, { v: "g" });
  assert.equal(f.reads(), 3, "other qualifications are another read");
  f.advance(-1);
  reader(f.path, f.db, NOW, { v: "g" });
  assert.equal(f.reads(), 4, "a clock that went back reads again");
});

test("W1-T13536 criterion 3: a read that throws or finds no store is never kept, so the next pass reads again", (t) => {
  const f = fixture(t);
  let calls = 0;
  let fail = false;
  const flaky: typeof readShadowCounters = (...args) => { calls += 1; if (fail) throw new Error("locked"); return readShadowCounters(...args); };
  const reader = storedShadowReadinessReader(f.clock, STORED_READINESS_REFRESH_MS, flaky);
  assert.deepEqual(reader(f.path, f.db, NOW), [], "no store yet: the fallback answers");
  assert.equal(calls, 1);
  saveShadowCounter(f.path, {}, "v", state(10));
  fail = true;
  assert.throws(() => reader(f.path, f.db, NOW), /locked/);
  fail = false;
  assert.deepEqual(reader(f.path, f.db, NOW), storedShadowReadiness(f.path, f.db, NOW));
  assert.equal(calls, 3, "the absent and the failed read were not kept");
});

test("W1-T13536 criterion 4: the default reader reads the real store on the system clock", (t) => {
  const f = fixture(t);
  saveShadowCounter(f.path, {}, "v", state(10));
  const reader = storedShadowReadinessReader();
  assert.deepEqual(reader(f.path, f.db as ReadModelDb, NOW), storedShadowReadiness(f.path, f.db, NOW));
  assert.equal(reader(f.path, f.db, NOW).length, 1);
});
