/** Black-box regression: imports only APIs present at base, so a missing new module cannot be its falsifier. */
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { openProjectorReadModel } from "#src/lib/ledger-projector.js";
import { acquireLease, flushReadModelTransactions, openShadowCounterDb } from "#src/lib/read-model-db.js";
import { readShadowCounters, shadowCounterPath } from "#src/lib/view-shadow-store.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { createViewShadow, fileShadowStore, shadowReadiness, viewShadowPath, type ViewShadowState } from "#src/lib/view-shadow.js";

test("shadow persistence retains historical keys without rewriting their JSON on each sample", async t => {
  const dir = makeTempDir("shadow-counter-history"), clock = fixedClock(1792411200000);
  const db = openProjectorReadModel(dir, "core", clock), lease = acquireLease(db, { clock });
  assert(lease.ok);
  const path = viewShadowPath(dir);
  const history: ViewShadowState = { requests: 1, firstRequestMs: clock.now(), samples: 100,
    diffs: { legacy_horizon: 0, timing: 0, dedupe: 0, real: 0 }, streakSamples: 100,
    streakSinceMs: clock.now(), lastRealMs: null, streakKeys: Array.from({ length: 1000 }, (_, n) => `cursor-${n}-${"x".repeat(140)}`) };
  writeFileSync(path, JSON.stringify({ inbox: history }));
  const before = readFileSync(path), store = fileShadowStore(path, db, lease.lease);
  t.after(async () => { store.close?.(); db.close(); await flushReadModelTransactions(); rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });
  const next = store.load().inbox!;
  next.samples++;
  store.save("inbox", next);
  assert.equal(readFileSync(path).equals(before), true, "a counter increment must not rewrite the historical JSON");
  const restored = fileShadowStore(path, db, lease.lease);
  try { assert.equal(restored.load().inbox!.samples, 101); assert.deepEqual(restored.load().inbox!.streakKeys, history.streakKeys); }
  finally { restored.close?.(); }
});

test("W1-T10917: current Inbox qualification refuses incomplete and uncommitted evidence", async t => {
  const dir = makeTempDir("inbox-current-population-store"), clock = fixedClock(1792411200000), policy = "inbox-current-pages-v1";
  const db = openProjectorReadModel(dir, "core", clock), lease = acquireLease(db, { clock });
  assert(lease.ok);
  const path = viewShadowPath(dir), stateKey = `\u0000qualification:${JSON.stringify(["inbox", policy])}`;
  const history: ViewShadowState = { requests: 1, firstRequestMs: clock.now() - 2 * 86400000, samples: 3000,
    diffs: { legacy_horizon: 0, timing: 0, dedupe: 0, real: 0 }, streakSamples: 3000,
    streakSinceMs: clock.now() - 2 * 86400000, lastRealMs: null, streakKeys: Array.from({ length: 1000 }, (_, i) => `retired-cursor-${i}`) };
  const qualified = { ...history, view: "inbox", qualificationGeneration: policy, streakKeys: ["previous-page"] };
  assert.equal(shadowReadiness("inbox", qualified, clock.now()).ready, true, "the old scalar receipt is a real READY positive control");
  writeFileSync(path, JSON.stringify({ inbox: history, [stateKey]: qualified }));
  const original = readFileSync(path), seed = fileShadowStore(path, db, lease.lease);
  seed.save(stateKey, qualified); seed.close?.();
  const store = fileShadowStore(path, db, lease.lease, { inbox: policy });
  let blocker: ReturnType<typeof openShadowCounterDb> | undefined;
  t.after(async () => { if (blocker?.inTransaction()) blocker.exec("ROLLBACK"); blocker?.close(); store.close?.(); db.close(); await flushReadModelTransactions(); rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });
  assert.equal(store.load().inbox!.streakKeys?.length, 0, "retired routing membership is not hydrated by the current comparator");
  const active = readShadowCounters(path, false, { inbox: policy })!;
  assert.equal(active.keyCounts.has("inbox"), false, "current readiness does not recount the retired cursor population");
  assert.equal(active.keyCounts.get(stateKey), 1, "positive control: the actual current namespace is still counted");
  assert.deepEqual(readShadowCounters(path, true)!.states.inbox, history, "the full native history still exists independently");
  const scope = { instance: "core", repository: "craigoley/remudero" }, snapshotKey = "a".repeat(64);
  const page = { key: "section=needsYou", logicalKey: JSON.stringify([scope.instance, scope.repository, "needsYou", 0, []]), section: "needsYou", index: 0, incarnation: "fresh-0" };
  const complete = { policy, generation: policy, snapshotKey, scope, pages: [page] };
  let population: typeof complete | undefined;
  let sourceError = false;
  const shadow = createViewShadow({ clock, store, log() {}, evidence: () => ({ legacyAsOfMs: clock.now(), viewAsOfMs: clock.now(), named: new Set(), namedBeforeHorizon: new Set(), namedInGap: new Set(), rowsInGap: 0, duplicateIds: new Set(), duplicateRows: 0 }), qualifications: { inbox: policy },
    ...{ populationViews: ["inbox"], populations: () => { if (sourceError) throw new Error("unreadable producer metadata"); return { inbox: population }; } },
  });
  const current = () => shadow.readiness().find(row => row.view === "inbox")!;
  assert.equal(current().ready, false, "no population is UNKNOWN despite the old READY receipt");
  assert.match(current().reason, /no committed current page population/);
  population = { ...complete, pages: [] };
  assert.equal(current().ready, false); assert.match(current().reason, /malformed/);
  population = { ...complete, pages: [page, page] };
  assert.equal(current().ready, false); assert.match(current().reason, /duplicate/);
  sourceError = true;
  assert.equal(current().ready, false); assert.match(current().reason, /source failed.*unreadable producer metadata/);
  sourceError = false; population = complete;
  blocker = openShadowCounterDb(shadowCounterPath(path)); blocker.exec("BEGIN IMMEDIATE");
  const data = { snapshotKey, section: "needsYou", page: { index: 0, of: 1, total: 0 }, items: [] };
  const compare = () => shadow.compare({ view: "inbox", key: page.key, requests: 0, qualificationGeneration: policy,
    legacy: { data, asOfMs: clock.now(), qualificationGeneration: policy }, body: { data, asOf: clock.iso() } });
  assert.throws(compare, /locked|busy/i, "the real native counter writer refuses the competing transaction");
  assert.equal(current().ready, false); assert.match(current().reason, /persistence failed.*not committed/);
  blocker.exec("ROLLBACK"); blocker.close(); blocker = undefined;
  compare();
  assert.equal(current().ready, false); assert.match(current().reason, /own full day and cadence/);
  assert.equal(readFileSync(path).equals(original), true, "neither refused nor successful saves rewrite the historical JSON");
  assert.deepEqual(readShadowCounters(path, true)!.states.inbox, history, "retired native keys and old counters remain exactly measured");
});
