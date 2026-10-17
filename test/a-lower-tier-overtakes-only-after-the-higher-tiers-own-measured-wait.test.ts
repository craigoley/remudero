import assert from "node:assert/strict";
import test from "node:test";
import { buildDispatchValueContext, censoredMedianWaitMs, costOfDelayReadyRow } from "../src/lib/dispatch-value.js";
import type { DispatchValueContext, TierWait } from "../src/lib/dispatch-value.js";
import { dispatchOrder } from "../src/lib/drain.js";
import type { Task } from "../src/lib/plan.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-17T02:00:00Z");
const task = (id: string, over: Partial<Task> = {}): Task => ({
  id, title: id, repo: "remudero", depends_on: [], files: ["src/a.ts"],
  type: "implement", verify: "auto", risk: "high", status: "queued", attempts: 0, ...over,
});

interface Started { id: string; priority?: number; wait: number; startAgo: number; inPlan?: boolean }
interface Waiting { task: Task; filedAgo: number }

/** Started tasks are merged history (in the plan unless `inPlan: false`); waiting tasks are the open queue. */
function calibrate(started: readonly Started[], waiting: readonly Waiting[]): DispatchValueContext {
  const rows: Array<Record<string, unknown>> = [];
  const filed = new Map<string, number>();
  for (const s of started) {
    const at = NOW - s.startAgo;
    filed.set(s.id, at - s.wait);
    rows.push({ step: "run.start", task_id: s.id, run_id: s.id, task_class: "src", ts: new Date(at).toISOString() });
    rows.push({ step: "verdict", task_id: s.id, run_id: s.id, verdict: "merged", cost_usd: 2, ts: new Date(at + HOUR).toISOString() });
  }
  for (const w of waiting) filed.set(w.task.id, NOW - w.filedAgo);
  const tasks = [
    ...started.filter(s => s.inPlan !== false).map(s => task(s.id, s.priority === undefined ? {} : { priority: s.priority })),
    ...waiting.map(w => w.task),
  ];
  const result = buildDispatchValueContext(tasks, rows, new Set(waiting.map(w => w.task.id)), NOW, true, "seed", {
    planTreeSha: "tree-sha", filedAtByTaskId: filed,
  });
  assert.equal(result.kind, "ready");
  return result.context;
}

const tierWaits = (context: DispatchValueContext): readonly TierWait[] => costOfDelayReadyRow("tree-sha", context).tier_waits ?? [];
const tier = (context: DispatchValueContext, priority: number | null) => tierWaits(context).find(w => w.priority === priority);

// The falsifier fixture. Outside the plan, eight tasks each waited 10 h. The P1 tier started after 6, 10, 24 and
// 30 h, and two P1 tasks are still waiting at 26 and 28 h. The survivor median over all twelve starts is 10 h;
// the P1 tier's censoring-aware wait is 24 h (survival 5/6, 4/6, then 3/6 at 24 h).
const p1Fresh = task("W1-T9926", { priority: 1 });
function falsifier(p2Age: number) {
  const p2 = task("W1-T9800", { priority: 2 });
  const started: Started[] = [
    ...Array.from({ length: 8 }, (_, i) => ({ id: `W1-T${6000 + i}`, wait: 10 * HOUR, startAgo: 48 * HOUR, inPlan: false })),
    ...[6, 10, 24, 30].map((wait, i) => ({ id: `W1-T${6100 + i}`, priority: 1, wait: wait * HOUR, startAgo: 40 * HOUR })),
  ];
  const waiting: Waiting[] = [
    { task: p1Fresh, filedAgo: 0 }, { task: p2, filedAgo: p2Age },
    { task: task("W1-T6200", { priority: 1 }), filedAgo: 26 * HOUR }, { task: task("W1-T6201", { priority: 1 }), filedAgo: 28 * HOUR },
  ];
  const context = calibrate(started, waiting);
  return { p2, context, order: dispatchOrder([p2, p1Fresh], context).map(t => t.id) };
}

test("W1-T9967: an old P2 inside the P1 tier measured wait does not outrank a fresh P1", () => {
  // Base: the 10 h survivor median gives a 12 h P2 2^-1 * (1 + log2(2.2)) = 1.07 > 1. Tier unit: 0.79 < 1.
  const { p2, context, order } = falsifier(12 * HOUR);
  assert.deepEqual(order, [p1Fresh.id, p2.id], "a 12 h P2 waits behind the fresh P1");
  assert.deepEqual(tier(context, 1), { priority: 1, wait_ms: 24 * HOUR, events: 4, censored: 3, source: "own" });
  assert.equal(tier(context, 2)?.source, "pooled");
  assert.equal(tier(context, 2)?.wait_ms, 10 * HOUR, "the pooled curve crosses at the 10 h starts");
});

test("W1-T9967: past the P1 tier measured wait the old P2 still rises", () => {
  // 2^-1 * (1 + log2(1 + 30h/24h)) = 1.08 > 1: W1-T9323's aging is kept, in the P1 tier's own unit.
  const { p2, order } = falsifier(30 * HOUR);
  assert.deepEqual(order, [p2.id, p1Fresh.id]);
});

test("W1-T9967: a tier wait counts its still-waiting tasks as censored", () => {
  const started = [2, 3, 4].map((wait, i) => ({ id: `W1-T${6300 + i}`, priority: 2, wait: wait * HOUR, startAgo: 30 * HOUR }));
  const waiting = [0, 1, 2].map(i => ({ task: task(`W1-T${6400 + i}`, { priority: 2 }), filedAgo: 20 * HOUR }));
  const context = calibrate(started, waiting);
  // Survival 5/6 at 2 h, 4/6 at 3 h, 3/6 at 4 h: the three still waiting hold the curve up past the 3 h median.
  assert.deepEqual(tier(context, 2), { priority: 2, wait_ms: 4 * HOUR, events: 3, censored: 3, source: "own" });
  assert.equal(censoredMedianWaitMs([2, 3, 4].map(h => h * HOUR), []), 3 * HOUR, "a survivor-only median reads 3 h");
});

test("W1-T9967: a tier with no crossing of its own borrows the pooled wait and the ready row names it", () => {
  const started = Array.from({ length: 8 }, (_, i) => ({ id: `W1-T${6500 + i}`, priority: 1, wait: 2 * HOUR, startAgo: 10 * HOUR }));
  const p3 = [0, 1].map(i => ({ task: task(`W1-T${6600 + i}`, { priority: 3 }), filedAgo: HOUR }));
  const unprioritized = { task: task("W1-T6602"), filedAgo: HOUR };
  const context = calibrate(started, [...p3, unprioritized]);
  assert.deepEqual(tier(context, 1), { priority: 1, wait_ms: 2 * HOUR, events: 8, censored: 0, source: "own" });
  assert.deepEqual(tier(context, 3), { priority: 3, wait_ms: 2 * HOUR, events: 0, censored: 2, source: "pooled" });
  assert.deepEqual(tier(context, null), { priority: null, wait_ms: 2 * HOUR, events: 0, censored: 1, source: "pooled" });
  const row = costOfDelayReadyRow("tree-sha", context);
  assert.equal(row.key, "ready:tree-sha", "tier waits are ledgered once per plan tree");
  // A pooled curve that never crosses one half: its longest event is a lower bound, and the row says so.
  const sparse = [0, 1].map(i => ({ id: `W1-T${6700 + i}`, priority: 1, wait: 2 * HOUR, startAgo: 30 * HOUR }));
  const queue = [0, 1, 2, 3].map(i => ({ task: task(`W1-T${6800 + i}`, { priority: 2 }), filedAgo: 20 * HOUR }));
  const bounded = calibrate(sparse, queue);
  assert.deepEqual(tier(bounded, 2), { priority: 2, wait_ms: 2 * HOUR, events: 0, censored: 4, source: "pooled-lower-bound", bound: "lower" });
  assert.equal(tier(bounded, 1)?.source, "own", "the P1 tier's own two starts still cross on their own");
});

test("W1-T9967: a lower tier never closes its gap faster than a higher tier wait", () => {
  const started = [
    ...[0, 1, 2].map(i => ({ id: `W1-T${6900 + i}`, priority: 1, wait: 24 * HOUR, startAgo: 30 * HOUR })),
    ...[0, 1, 2].map(i => ({ id: `W1-T${6910 + i}`, priority: 2, wait: 2 * HOUR, startAgo: 30 * HOUR })),
  ];
  const fresh = task("W1-T6920", { priority: 1 });
  const old = task("W1-T6921", { priority: 2 });
  const at = (age: number) => calibrate(started, [{ task: fresh, filedAgo: 0 }, { task: old, filedAgo: age }]);
  const held = at(12 * HOUR);
  // The P2 tier's own wait is 2 h; in it a 12 h P2 would score 2^-1 * (1 + log2(7)) = 1.9. It ages in P1's 24 h.
  assert.equal(tier(held, 2)?.wait_ms, 2 * HOUR);
  assert.equal(tier(held, 2)?.source, "own");
  assert.deepEqual(dispatchOrder([old, fresh], held).map(t => t.id), [fresh.id, old.id]);
  assert.deepEqual(dispatchOrder([fresh, old], at(30 * HOUR)).map(t => t.id), [old.id, fresh.id], "past P1's wait it rises");
});
