// P2-08 (arch Phase 2 design §4.2 lever 2): the read-model worker budgets view materialization per tick, as
// #8160 budgeted projection. A pass that spends its budget defers the remaining views to the next tick, which
// starts with them, so a slow view (now, after a daemon boot) bounds a tick without starving the views after it.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import type { Clock } from "../src/lib/clock.js";
import { createReadModelTicker, type ReadModelView, type ReadModelWorkerMessage } from "../src/lib/read-model-worker.js";
import { makeTempDir } from "../src/lib/tmp.js";

const T0 = Date.parse("2026-09-30T12:00:00.000Z");

function rig(t: { after: (fn: () => void) => void }, costs: Record<string, number>) {
  const stateDir = makeTempDir("materialize-budget");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  let at = T0;
  const clock: Clock = { now: () => at, date: () => new Date(at), iso: () => new Date(at).toISOString() };
  const ran: string[][] = [];
  let pass: string[] = [];
  let n = 0;
  const view = (name: string): ReadModelView => ({
    name,
    version: 1,
    materialize: () => {
      pass.push(name);
      at += costs[name] ?? 0;
      return [{ key: "", data: { name, n: n++ }, sources: [] }];
    },
  });
  const posted: ReadModelWorkerMessage[] = [];
  const ticker = createReadModelTicker({ stateDir, instances: [], views: Object.keys(costs).map(view), clock, holder: "budget", post: (m) => void posted.push(m), materializeBudgetMs: 100 });
  const tick = (): string[] => {
    pass = [];
    ticker.tick();
    ran.push(pass);
    at += 250;
    return pass;
  };
  return { tick, posted };
}

test("a materialize pass over budget defers the remaining views to the next tick", (t) => {
  const { tick, posted } = rig(t, { slow: 150, a: 10, b: 10 });
  assert.deepEqual(tick(), ["slow"], "slow spent the budget, so a and b wait");
  assert.deepEqual(tick(), ["a", "b", "slow"], "the next pass starts with the deferred views");
  assert.deepEqual(tick(), ["slow"]);
  const deferred = posted.filter((m) => m.type === "log" && m.step === "read_model.materialize_deferred");
  assert.equal(deferred.length, 1, "logged once per stale bound, not every tick");
  assert.deepEqual((deferred[0] as { extra: Record<string, unknown> }).extra, { ms: 150, budgetMs: 100, deferred: ["a", "b"] });
});

test("a materialize pass under budget runs every view in order", (t) => {
  const { tick } = rig(t, { a: 10, b: 10, c: 10 });
  assert.deepEqual(tick(), ["a", "b", "c"]);
  assert.deepEqual(tick(), ["a", "b", "c"]);
});

test("a single view over budget still runs every tick so nothing starves", (t) => {
  const { tick } = rig(t, { a: 500, b: 500 });
  assert.deepEqual([tick(), tick(), tick()], [["a"], ["b"], ["a"]]);
});
