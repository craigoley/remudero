// A refused managed-target WIP read never ends the daemon.
//
// 2026-11-07: #17144 (W1-T11458) made the daemon's synchronous GitHub pacer refuse a due wait. The managed-target
// board read then came back empty at every boot, openPrOwnership threw "target WIP unreadable", the throw escaped
// runDaemon, and core exited 1 every 2-3 minutes, so no review finished. These tests pin the replacement: a refused
// read reuses the target's last good count, or counts the target as unbounded so dispatch holds for that pass.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTargetWipMemory } from "#src/lib/target-wip-ownership.js";

test("a refused target WIP read with no good count yet holds dispatch, and the next good read is fresh", () => {
  const read = createTargetWipMemory();
  const refused = read("craigoley/wreckterra", () => undefined);
  assert.equal(refused.source, "unreadable");
  assert.equal(refused.counts.owned, Number.POSITIVE_INFINITY, "an unknown target counts as unbounded, so the WIP budget is zero");
  assert.equal(refused.counts.foreign, 0);
  const fresh = read("craigoley/wreckterra", () => ({ owned: 2, foreign: 1 }));
  assert.deepEqual(fresh, { counts: { owned: 2, foreign: 1 }, source: "fresh" });
});

test("a refused or throwing target WIP read after a good one reuses that target's last good count", () => {
  const read = createTargetWipMemory();
  read("craigoley/wreckterra", () => ({ owned: 3, foreign: 0 }));
  read("craigoley/other", () => ({ owned: 7, foreign: 2 }));
  assert.deepEqual(read("CRAIGOLEY/WRECKTERRA", () => undefined), { counts: { owned: Infinity, foreign: 0 }, source: "unreadable", lastKnownCounts: { owned: 3, foreign: 0 } });
  const threw = read("craigoley/wreckterra", () => { throw new Error("gh call pacer refused to sleep 1011ms on this thread"); });
  assert.deepEqual(threw, { counts: { owned: Infinity, foreign: 0 }, source: "unreadable", lastKnownCounts: { owned: 3, foreign: 0 } });
});


test("cached target history is diagnostic only through refusal, recovery and target isolation", () => {
  const read = createTargetWipMemory();
  read("audit/zero", () => ({ owned: 0, foreign: 2 }));
  read("audit/other", () => ({ owned: 4, foreign: 1 }));
  assert.deepEqual(read("AUDIT/ZERO", () => undefined), { counts: { owned: Infinity, foreign: 0 }, source: "unreadable", lastKnownCounts: { owned: 0, foreign: 2 } });
  assert.deepEqual(read("audit/zero", () => ({ owned: 1, foreign: 3 })), { counts: { owned: 1, foreign: 3 }, source: "fresh" });
  assert.deepEqual(read("audit/zero", () => { throw new Error("private refused read"); }), { counts: { owned: Infinity, foreign: 0 }, source: "unreadable", lastKnownCounts: { owned: 1, foreign: 3 } });
  assert.deepEqual(read("audit/other", () => undefined), { counts: { owned: Infinity, foreign: 0 }, source: "unreadable", lastKnownCounts: { owned: 4, foreign: 1 } });
});
