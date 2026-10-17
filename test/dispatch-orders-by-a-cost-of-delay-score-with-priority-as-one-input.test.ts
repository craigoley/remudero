import assert from "node:assert/strict";
import test from "node:test";
import { buildDispatchValueContext, costOfDelayReadyRow } from "../src/lib/dispatch-value.js";
import type { DispatchValueContext } from "../src/lib/dispatch-value.js";
import { compareDispatch, dispatchOrder } from "../src/lib/drain.js";
import type { Task } from "../src/lib/plan.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-13T12:00:00Z");
const task = (id: string, over: Partial<Task> = {}): Task => ({
  id, title: id, repo: "remudero", depends_on: [], files: ["src/a.ts"],
  type: "implement", verify: "auto", risk: "high", status: "queued", attempts: 0, ...over,
});

// A measured src-class history in which every task waited exactly two hours from filing to first start,
// so the median wait is 2 h and every outcome is valid (age moves urgency only, never the validity share).
const MEDIAN_WAIT = 2 * HOUR;
const history: Array<Record<string, unknown>> = [];
const historyDates = new Map<string, number>();
for (let i = 0; i < 8; i++) {
  const id = `W1-T${6000 + i}`;
  const startedAt = NOW - 10 * HOUR;
  historyDates.set(id, startedAt - MEDIAN_WAIT);
  history.push({ step: "run.start", task_id: id, run_id: id, task_class: "src", ts: new Date(startedAt).toISOString() });
  history.push({ step: "verdict", task_id: id, run_id: id, verdict: "merged", cost_usd: 2, ts: new Date(startedAt + HOUR).toISOString() });
}

function calibrate(tasks: Task[], filedAgo: Record<string, number>, rows = history, dates = historyDates) {
  const filed = new Map(dates);
  for (const [id, ago] of Object.entries(filedAgo)) filed.set(id, NOW - ago);
  const result = buildDispatchValueContext(tasks, rows, new Set(tasks.map(t => t.id)), NOW, true, "seed", {
    planTreeSha: "tree-sha", filedAtByTaskId: filed,
  });
  assert.equal(result.kind, "ready");
  return result.context;
}

test("W1-T9323: a lower-priority task that has waited past the median wait outranks a fresh higher-priority task", () => {
  const waited = task("W1-T7001", { priority: 2 });
  const fresh = task("W1-T7002", { priority: 1 });
  const context = calibrate([fresh, waited], { [waited.id]: 5 * HOUR, [fresh.id]: 0 });
  // W1-T9967: neither tier has events of its own, so both borrow the pooled 2 h wait. The P2 ages in that
  // unit: 2^-1 * (1 + log2(1 + 5h/2h)) = 1.40 against the fresh P1's 1, so its pass is the smaller.
  assert.ok(context.stridePassByTaskId!.get(waited.id)! < context.stridePassByTaskId!.get(fresh.id)!);
  assert.deepEqual(dispatchOrder([fresh, waited], context).map(t => t.id), [waited.id, fresh.id]);
  assert.deepEqual(dispatchOrder([waited, fresh], context).map(t => t.id), [waited.id, fresh.id]);
  // W1-T9967: give the P1 tier its own history, an 8 h wait. The P2 now ages in that unit:
  // 2^-1 * (1 + log2(1 + 5h/8h)) = 0.85 < 1 at 5 h, and 2^-1 * (1 + log2(1 + 12h/8h)) = 1.16 > 1 at 12 h.
  const p1History = [0, 1, 2].map(i => task(`W1-T710${i}`, { priority: 1 }));
  const rows = [...history, ...p1History.flatMap(t => [
    { step: "run.start", task_id: t.id, run_id: t.id, task_class: "src", ts: new Date(NOW - 10 * HOUR).toISOString() },
    { step: "verdict", task_id: t.id, run_id: t.id, verdict: "merged", cost_usd: 2, ts: new Date(NOW - 9 * HOUR).toISOString() },
  ])];
  const ownWait = (ago: number) => {
    const dates = new Map([...historyDates, ...p1History.map(t => [t.id, NOW - 18 * HOUR] as const), [waited.id, NOW - ago], [fresh.id, NOW]]);
    const result = buildDispatchValueContext([...p1History, fresh, waited], rows, new Set([fresh.id, waited.id]), NOW, true, "seed", {
      planTreeSha: "tree-sha", filedAtByTaskId: dates,
    });
    assert.equal(result.kind, "ready");
    return result.context;
  };
  assert.deepEqual(dispatchOrder([waited, fresh], ownWait(5 * HOUR)).map(t => t.id), [fresh.id, waited.id],
    "W1-T9967: inside the higher tier measured wait the fresh task still leads");
  assert.deepEqual(dispatchOrder([fresh, waited], ownWait(12 * HOUR)).map(t => t.id), [waited.id, fresh.id],
    "past the higher tier measured wait the old task leads again");
});

test("W1-T9323: between equally old tasks the higher priority dispatches first", () => {
  const high = task("W1-T7012", { priority: 1 });
  const low = task("W1-T7011", { priority: 2 });
  const context = calibrate([low, high], { [low.id]: 3 * HOUR, [high.id]: 3 * HOUR });
  assert.ok(context.stridePassByTaskId!.get(high.id)! < context.stridePassByTaskId!.get(low.id)!, "the head start is the difference");
  assert.deepEqual(dispatchOrder([low, high], context).map(t => t.id), [high.id, low.id], "the lower id does not win");
  // Priority is also the first tiebreak when two passes are exactly equal.
  const tied: DispatchValueContext = { ...context, stridePassByTaskId: new Map([[low.id, 1], [high.id, 1]]) };
  assert.deepEqual(dispatchOrder([low, high], tied).map(t => t.id), [high.id, low.id]);
});

// Hand correction: priority now weights urgency by 2^-tierGap instead of adding the share of the queue a task
// outranks, so a sub-1 priority buys its own small tier gap (test/priority-weights-dispatch-urgency-so-age-cannot-swamp-intent.test.ts).
test("W1-T9323: a priority below the queue head buys only its own tier gap", () => {
  const others = Array.from({ length: 8 }, (_, i) => task(`W1-T710${i}`, { priority: 1 }));
  const age = Object.fromEntries([...others.map(t => [t.id, 4 * HOUR]), ["W1-T7200", 4 * HOUR], ["W1-T7201", 4 * HOUR]]);
  const half = task("W1-T7200", { priority: 0.5 });
  const nine = task("W1-T7201", { priority: 0.9 });
  const context = calibrate([...others, half, nine], age);
  const ratio = context.costOfDelayByTaskId!.get(half.id)! / context.costOfDelayByTaskId!.get(nine.id)!;
  assert.ok(Math.abs(ratio - 2 ** 0.4) < 1e-9, `ratio ${ratio}`);
});

test("W1-T9323: an undatable open task is scored at age zero and named as imputed", () => {
  const undatable = task("NEW-1A", { priority: 1 });
  const stale = task("W1-T7301", { priority: 2 });
  const fresh = task("W1-T7302", { priority: 3 });
  const tasks = [fresh, undatable, stale];
  const context = calibrate(tasks, { [stale.id]: 10 * HOUR, [fresh.id]: 0 });
  assert.deepEqual(context.costOfDelayImputed, [undatable.id]);
  assert.equal(context.costOfDelayUnscored, undefined, "a ready context never leaves a task unscored");
  assert.ok(context.stridePassByTaskId!.has(undatable.id));
  assert.ok(context.costOfDelayByTaskId!.has(undatable.id));
  // It sorts by its own pass at age zero: behind the stale task, ahead of the equally fresh one it outranks.
  assert.deepEqual(dispatchOrder(tasks, context).map(t => t.id), [stale.id, undatable.id, fresh.id]);
  // The ready row names it, once per plan tree. W1-T9967: the row also carries every tier's wait.
  const { tier_waits: waits, ...named } = costOfDelayReadyRow("tree-sha", context);
  assert.deepEqual(named, { key: "ready:tree-sha", plan_tree_sha: "tree-sha", imputed: [undatable.id] });
  assert.deepEqual(waits?.map(w => w.priority), [1, 2, 3]);
  const { tier_waits: plainWaits, ...plain } = costOfDelayReadyRow("tree-sha", calibrate([stale, fresh], { [stale.id]: HOUR, [fresh.id]: 0 }));
  assert.deepEqual(plain, { key: "ready:tree-sha", plan_tree_sha: "tree-sha" });
  assert.deepEqual(plainWaits?.map(w => w.priority), [2, 3]);
});

test("W1-T9323: without a ready cost-of-delay context the order stays priority first", () => {
  const waited = task("W1-T7401", { priority: 2 });
  const fresh = task("W1-T7402", { priority: 1 });
  const ready = calibrate([fresh, waited], { [waited.id]: 5 * HOUR, [fresh.id]: 0 });
  assert.equal(dispatchOrder([waited, fresh], ready)[0].id, waited.id, "the ready context ranks by pass");
  assert.deepEqual(dispatchOrder([waited, fresh]).map(t => t.id), [fresh.id, waited.id], "no context");
  const fallback: DispatchValueContext = { ...ready, costOfDelayFallback: true };
  assert.deepEqual(dispatchOrder([waited, fresh], fallback).map(t => t.id), [fresh.id, waited.id], "fallback context");
  assert.equal(compareDispatch(waited, fresh, fallback), 1);
});

test("W1-T9323: a queue with no measured wait is refused as no-wait-evidence", () => {
  const only = task("W1-T7501", { priority: 1 });
  const result = buildDispatchValueContext([only], history, new Set([only.id]), NOW, true, "seed", {
    planTreeSha: "tree-sha", filedAtByTaskId: new Map([[only.id, NOW - HOUR]]),
  });
  assert.deepEqual(result, { kind: "refused", reasons: ["no-wait-evidence"] });
});
