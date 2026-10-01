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
  let pass: string[] = [];
  const view = (name: string): ReadModelView => ({
    name, version: 1,
    materialize: () => {
      pass.push(name);
      at += costs[name] ?? 0;
      return [{ key: "", data: { name }, sources: [] }];
    },
  });
  const posted: ReadModelWorkerMessage[] = [];
  const ticker = createReadModelTicker({ stateDir, instances: [], views: Object.keys(costs).map(view), clock, holder: "budget", post: (m) => void posted.push(m), passBudgetMs: 100 });
  const tick = (): string[] => {
    pass = [];
    ticker.tick();
    at += 250;
    return pass;
  };
  const advance = (ms: number): void => { at += ms; };
  const deferred = () => posted.filter((m) => m.type === "log" && m.step === "read_model.materialize_deferred");
  return { tick, advance, deferred };
}

test("a materialize pass names budget-deferred units and later builds them", (t) => {
  const { tick, deferred } = rig(t, { slow: 150, a: 10, b: 10 });
  assert.deepEqual(tick(), ["slow"]);
  assert.deepEqual((deferred()[0] as { extra: Record<string, unknown> }).extra, { ms: 150, budgetMs: 100, deferred: ["a", "b"] });
  const subsequent = [tick(), tick(), tick()].flat();
  assert.ok(subsequent.includes("a") && subsequent.includes("b"), "both deferred units eventually run");
});

test("a materialize deferral is sampled at most once per stale window", (t) => {
  const { tick, advance, deferred } = rig(t, { slow: 150, a: 50, b: 50 });
  for (let i = 0; i < 6; i++) tick();
  assert.equal(deferred().length, 1);
  advance(10_000);
  tick();
  tick();
  assert.equal(deferred().length, 2, "a later budget deferral produces a new sample");
});

test("a measured view that fits the pass has no budget deferral", (t) => {
  const { tick, advance, deferred } = rig(t, { a: 10 });
  assert.deepEqual(tick(), ["a"]);
  advance(10_000);
  assert.deepEqual(tick(), ["a"]);
  assert.equal(deferred().length, 0);
});

test("a view with prepare steps spreads a long build over ticks and posts its body only once prepared", (t) => {
  const stateDir = makeTempDir("materialize-steps");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  let at = T0;
  const clock: Clock = { now: () => at, date: () => new Date(at), iso: () => new Date(at).toISOString() };
  let done = 0;
  const perTick: number[] = [];
  const view: ReadModelView = {
    name: "stepped", version: 1,
    prepare: (_ctx, more) => {
      let steps = 0;
      while (done < 10 && more()) {
        at += 15;
        done += 1;
        steps += 1;
      }
      perTick.push(steps);
      return done === 10;
    },
    materialize: () => [{ key: "", data: { done }, sources: [] }],
  };
  const bodies: unknown[] = [];
  const ticker = createReadModelTicker({ stateDir, instances: [], views: [view], clock, holder: "steps", post: (m) => void (m.type === "body" && bodies.push(m.entry.body.data)), passBudgetMs: 100 });
  ticker.tick();
  assert.deepEqual(perTick, [3], "steps stop at the 40 ms view share; the first is always allowed");
  assert.deepEqual(bodies, [], "no body before prepare is done");
  for (let i = 0; i < 20 && bodies.length === 0; i++) {
    at += 250;
    ticker.tick();
  }
  assert.deepEqual(bodies, [{ done: 10 }]);
  assert.deepEqual(perTick, [3, 3, 3, 1]);
});
