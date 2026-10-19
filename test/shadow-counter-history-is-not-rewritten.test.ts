/** Black-box regression: imports only APIs present at base, so a missing new module cannot be its falsifier. */
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import { openProjectorReadModel } from "../src/lib/ledger-projector.js";
import { acquireLease, flushReadModelTransactions } from "../src/lib/read-model-db.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { fileShadowStore, viewShadowPath, type ViewShadowState } from "../src/lib/view-shadow.js";

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
  assert.deepEqual(readFileSync(path), before, "a counter increment must not rewrite the historical JSON");
  const restored = fileShadowStore(path, db, lease.lease);
  try { assert.equal(restored.load().inbox!.samples, 101); assert.deepEqual(restored.load().inbox!.streakKeys, history.streakKeys); }
  finally { restored.close?.(); }
});
